import { createApi } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn } from '@reduxjs/toolkit/query/react'
import type {
  MaterialFile,
  MaterialPackage,
  PageReview,
  ReviewComment,
  WorkspaceState,
} from '@/types/domain'
import { loadWorkspace, resetWorkspace, saveWorkspace } from '@/services/storage'
import { createApprovalRoute, findApplicableRule, validatePackage } from '@/services/rules'
import {
  activateFirstPending,
  applyDriftEffects,
  buildFrozenBaseline,
  detectDrift,
  getHeldReservation,
  getPackageLicense,
  getRulePool,
  isRouteFullyApproved,
  regenerateRoute,
} from '@/services/reconciliation'

type MockRequest = {
  url: string
  method: 'GET' | 'POST'
  body?: unknown
}

type MockError = {
  status: number
  error: string
  remaining?: number
  holders?: { packageCode: string; owner: string; amount: number }[]
}

const wait = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms))
const now = () => new Date().toISOString()

class ChainConflictError extends Error {
  payload: MockError
  constructor(payload: MockError) {
    super(payload.error)
    this.name = 'ChainConflictError'
    this.payload = payload
  }
}

type AuditWriter = (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => void

/**
 * 串行化 load → 变更 → save 临界区：两个窗口同时提交预占时，第二个临界区
 * 必须在第一个落盘后重新读回预占人与剩余额度，保证同一笔额度只有一个成功。
 */
let transactionQueue: Promise<unknown> = Promise.resolve()
function runTransaction<T>(
  fn: (state: WorkspaceState, audit: AuditWriter) => T,
): Promise<T> {
  const run = transactionQueue.then(async () => {
    await wait()
    const state = loadWorkspace()
    const audit: AuditWriter = (entry) => {
      state.audit.unshift({ ...entry, id: `audit-${crypto.randomUUID()}`, createdAt: now() })
    }
    const result = fn(state, audit)
    saveWorkspace(state)
    return result
  })
  transactionQueue = run.catch(() => undefined)
  return run
}

/** 扫描冻结基线漂移并即时失效；返回本次新增漂移条数 */
function reconcile(state: WorkspaceState, audit: AuditWriter): number {
  let count = 0
  state.packages.forEach((packageItem) => {
    const baseline = packageItem.frozenBaseline
    if (!baseline) return
    const license = getPackageLicense(packageItem.id, state)
    const fresh = detectDrift(baseline, packageItem, state.files)
    if (!fresh.length) return
    count += fresh.length
    baseline.driftChanges.push(...fresh)
    if (license) license.drifts.push(...fresh)
    const details = applyDriftEffects(packageItem, fresh, license)
    details.forEach((detail) => {
      audit({
        packageId: packageItem.id,
        action: '冻结基线漂移',
        target: packageItem.code,
        operator: '系统核对链',
        detail,
      })
    })
  })
  return count
}

function driftFindings(packageItem: MaterialPackage) {
  const baseline = packageItem.frozenBaseline
  if (!baseline) return []
  return baseline.driftChanges.map((drift, index) => ({
    id: `${packageItem.id}-baseline-drift-${index}`,
    packageId: packageItem.id,
    type: 'baseline-drift' as const,
    level: 'high' as const,
    message: `冻结对象已变化：${drift.target} 由「${drift.before}」变为「${drift.after}」。`,
    action: '未完成路线已即时失效，已通过步骤保留；请重新生成路线后继续。',
    ruleId: packageItem.matchedRuleId,
  }))
}

const mockBaseQuery: BaseQueryFn<MockRequest, unknown, MockError> = async ({
  url,
  body,
}) => {
  const payload = (body ?? {}) as Record<string, unknown>

  try {
    const data = await runTransaction((state, audit) => {
      if (url === '/workspace') {
        reconcile(state, audit)
        return state
      }

      if (url === '/package/save') {
        const packageId = String(payload.packageId)
        const patch = payload.patch as Partial<MaterialPackage>
        const current = state.packages.find((item) => item.id === packageId)
        if (!current) throw new Error('资料包不存在')
        Object.assign(current, patch, { updatedAt: now() })
        current.matchedRuleId = findApplicableRule(current, state.rules)?.id
        reconcile(state, audit)
        audit({
          packageId,
          action: '更新资料包',
          target: current.code,
          operator: '当前用户',
          detail: '更新收件方、最终用途、声明或技术参数；如与冻结基线不一致将即时失效路线。',
        })
      } else if (url === '/package/create') {
        const draft = payload.package as Omit<
          MaterialPackage,
          'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
        >
        const rule = findApplicableRule(
          { ...draft, id: 'temp', approvalRoute: [], versions: [], currentRound: 0, createdAt: '', updatedAt: '' },
          state.rules,
        )
        const packageItem: MaterialPackage = {
          ...draft,
          id: `pkg-${crypto.randomUUID()}`,
          matchedRuleId: rule?.id,
          approvalRoute: [],
          currentRound: 0,
          createdAt: now(),
          updatedAt: now(),
          versions: [],
        }
        packageItem.versions.push({
          id: `version-${crypto.randomUUID()}`,
          label: 'V1.0',
          createdAt: now(),
          createdBy: packageItem.applicant,
          summary: '创建资料包初始版本。',
          snapshot: {
            title: packageItem.title,
            category: packageItem.category,
            destination: packageItem.destination,
            endUse: packageItem.endUse,
            technologyTags: [...packageItem.technologyTags],
            personnelScopes: [...packageItem.personnelScopes],
            declarations: [...packageItem.declarations],
            activeFileVersions: {},
          },
        })
        state.packages.unshift(packageItem)
        audit({
          packageId: packageItem.id,
          action: '创建资料包',
          target: packageItem.code,
          operator: packageItem.applicant,
          detail: `目的地：${packageItem.destination}，资料类型：${packageItem.category}。`,
        })
      } else if (url === '/file/save') {
        const file = payload.file as MaterialFile
        const index = state.files.findIndex((item) => item.id === file.id)
        if (index >= 0) state.files[index] = file
        else state.files.push(file)
        reconcile(state, audit)
      } else if (url === '/file/version/add') {
        const packageId = String(payload.packageId)
        const fileId = String(payload.fileId)
        const file = state.files.find((item) => item.id === fileId && item.packageId === packageId)
        if (!file) throw new Error('文件不存在')
        const pageCount = Number(payload.pageCount)
        const label = String(payload.label)
        const summary = String(payload.summary)
        const newVersion = {
          id: `file-version-${crypto.randomUUID()}`,
          label,
          uploadedAt: now(),
          hash: crypto.randomUUID().slice(0, 8).toUpperCase(),
          sizeKb: pageCount * 96 + 720,
          pages: Array.from({ length: pageCount }, (_, index) => ({
            id: `page-${crypto.randomUUID()}`,
            page: index + 1,
            category: file.kind,
            controlled: false,
            desensitized: false,
            note: '',
            reviewer: '',
          })),
          changeSummary: summary,
        }
        file.versions.push(newVersion)
        file.activeVersionId = newVersion.id
        reconcile(state, audit)
        audit({
          packageId,
          action: '上传文件版本',
          target: `${file.name} ${label}`,
          operator: '当前用户',
          detail: summary,
        })
      } else if (url === '/file/reference') {
        const fileId = String(payload.fileId)
        const versionId = String(payload.versionId)
        const file = state.files.find((item) => item.id === fileId)
        if (!file) throw new Error('文件不存在')
        file.referencedVersionId = versionId
        reconcile(state, audit)
        audit({
          packageId: file.packageId,
          action: '选择引用版本',
          target: file.name,
          operator: '当前用户',
          detail: `引用版本调整为 ${file.versions.find((item) => item.id === versionId)?.label ?? versionId}；如已冻结将触发基线漂移。`,
        })
      } else if (url === '/page/save') {
        const file = state.files.find((item) => item.id === String(payload.fileId))
        const version = file?.versions.find((item) => item.id === String(payload.versionId))
        if (!file || !version) throw new Error('文件版本不存在')
        const page = payload.page as PageReview
        const index = version.pages.findIndex((item) => item.id === page.id)
        if (index >= 0) version.pages[index] = page
        else version.pages.push(page)
        audit({
          packageId: file.packageId,
          action: '逐页分类核对',
          target: `${file.name} 第 ${page.page} 页`,
          operator: page.reviewer || '当前用户',
          detail: page.controlled ? `标记受控，脱敏状态：${page.desensitized ? '已脱敏' : '待脱敏'}` : '标记为一般资料',
        })
      } else if (url === '/package/validate') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        reconcile(state, audit)
        const rule = findApplicableRule(packageItem, state.rules)
        const pool = rule ? getRulePool(rule.id, state) : undefined
        const base = validatePackage(packageItem, state.files, state.rules, pool?.remaining)
        state.findings = [
          ...state.findings.filter((item) => item.packageId !== packageId),
          ...base,
          ...driftFindings(packageItem),
        ]
        audit({
          packageId,
          action: '执行许可校验',
          target: packageItem.code,
          operator: '当前用户',
          detail: `生成 ${state.findings.filter((item) => item.packageId === packageId).length} 条核对结果。`,
        })
      } else if (url === '/package/version') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        const summary = String(payload.summary)
        const label = String(payload.label)
        packageItem.versions.push({
          id: `package-version-${crypto.randomUUID()}`,
          label,
          createdAt: now(),
          createdBy: '当前用户',
          summary,
          snapshot: {
            title: packageItem.title,
            category: packageItem.category,
            destination: packageItem.destination,
            endUse: packageItem.endUse,
            technologyTags: [...packageItem.technologyTags],
            personnelScopes: [...packageItem.personnelScopes],
            declarations: [...packageItem.declarations],
            activeFileVersions: Object.fromEntries(
              state.files
                .filter((file) => file.packageId === packageId)
                .map((file) => [file.id, file.activeVersionId]),
            ),
          },
        })
        reconcile(state, audit)
        audit({
          packageId,
          action: '创建资料包版本',
          target: `${packageItem.code} ${label}`,
          operator: '当前用户',
          detail: summary,
        })
      } else if (url === '/approval/submit') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        const rule = findApplicableRule(packageItem, state.rules)
        if (!rule) throw new Error('未匹配到许可规则')
        const activeHeld = getHeldReservation(packageId, state)
        if (activeHeld) {
          throw new Error('额度已预占，请先完成核销；核销失败可直接重试，无需重新提交审批')
        }
        if (packageItem.status === 'licensed' || packageItem.status === 'recheck') {
          throw new Error('已生成许可记录，不能重新提交审批')
        }
        // 重新生成路线：沿用同序同角色的已通过步骤，失效/等待步骤重新进入审批
        const hadApprovedStep = packageItem.approvalRoute.some((step) => step.status === 'approved')
        const regenerated = activateFirstPending(
          hadApprovedStep
            ? regenerateRoute(packageItem.approvalRoute, rule.approvalLevel)
            : createApprovalRoute(rule.approvalLevel),
        )
        packageItem.approvalRoute = regenerated
        packageItem.matchedRuleId = rule.id
        // 提交审批即冻结：资料包版本、文件引用版本和声明
        packageItem.frozenBaseline = buildFrozenBaseline(packageItem, state.files, '当前用户')
        packageItem.status = 'reviewing'
        packageItem.currentRound += 1
        audit({
          packageId,
          action: '提交审批',
          target: packageItem.code,
          operator: '当前用户',
          detail: `按 ${rule.name} ${hadApprovedStep ? '重新生成' : '生成'}审批路线，第 ${packageItem.currentRound} 轮；冻结资料包版本 ${packageItem.frozenBaseline.packageLabel}、${packageItem.frozenBaseline.fileReferences.length} 个文件引用版本与 ${packageItem.frozenBaseline.declarations.length} 项声明。`,
        })
      } else if (url === '/approval/decide') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        reconcile(state, audit)
        const step = packageItem.approvalRoute.find((item) => item.id === String(payload.stepId))
        if (!step || step.status !== 'active') throw new Error('当前步骤不可审批（可能已因冻结对象变化失效，请重新生成路线）')
        const decision = String(payload.decision)
        step.comment = String(payload.comment ?? '')
        step.decidedAt = now()
        if (decision === 'return') {
          step.status = 'returned'
          packageItem.status = 'returned'
        } else {
          step.status = 'approved'
          const next = packageItem.approvalRoute.find(
            (item) => item.order === step.order + 1 && item.status === 'waiting',
          )
          if (next) next.status = 'active'
          else if (isRouteFullyApproved(packageItem)) {
            packageItem.status = 'approved'
            audit({
              packageId,
              action: '审批放行',
              target: packageItem.code,
              operator: step.assignee,
              detail: '全部审批步骤通过，冻结基线核对一致，进入额度预占。',
            })
          }
        }
        audit({
          packageId,
          action: decision === 'return' ? '审批退回' : '审批通过',
          target: `${packageItem.code} / ${step.role}`,
          operator: step.assignee,
          detail: step.comment || '无补充意见。',
        })
      } else if (url === '/quota/reserve') {
        const packageId = String(payload.packageId)
        const amount = Number(payload.amount)
        const clientToken = String(payload.clientToken ?? '')
        const owner = String(payload.owner ?? '当前用户')
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        if (!clientToken) throw new Error('缺少预占幂等令牌')
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('预占额度必须大于 0')

        // 幂等：同令牌重试直接读回既有预占，不多占
        const byToken = state.reservations.find((item) => item.clientToken === clientToken)
        if (byToken) {
          audit({
            packageId,
            action: '额度预占重试',
            target: packageItem.code,
            operator: owner,
            detail: `相同预占请求重试，沿用既有预占 ${byToken.amount}，不重复占用。`,
          })
          return state
        }
        const held = getHeldReservation(packageId, state)
        if (held) {
          throw new ChainConflictError({
            status: 409,
            error: `该资料包已有 ${held.owner} 的在持预占 ${held.amount}，本次提交未占用额度。`,
          })
        }
        if (!isRouteFullyApproved(packageItem) || packageItem.status !== 'approved') {
          throw new Error('审批尚未全部放行，不能预占额度')
        }
        if (packageItem.frozenBaseline?.driftChanges.length) {
          throw new Error('冻结对象已变化，审批路线已失效，请重新生成路线后再预占')
        }
        const ruleId = packageItem.matchedRuleId ?? ''
        const pool = getRulePool(ruleId, state)
        if (pool.remaining < amount) {
          throw new ChainConflictError({
            status: 409,
            error: `许可额度不足：剩余 ${pool.remaining}，本次申请 ${amount}，预占失败。`,
            remaining: pool.remaining,
            holders: pool.holderDescriptions.map((item) => ({
              packageCode: item.packageCode,
              owner: item.owner,
              amount: item.amount,
            })),
          })
        }
        state.reservations.push({
          id: `reservation-${crypto.randomUUID()}`,
          packageId,
          ruleId,
          amount,
          status: 'held',
          owner,
          clientToken,
          heldAt: now(),
          attempts: 1,
          lastAttemptAt: now(),
        })
        packageItem.status = 'quota-held'
        audit({
          packageId,
          action: '额度预占',
          target: packageItem.code,
          operator: owner,
          detail: `预占 ${amount}，规则池剩余 ${pool.remaining - amount}（含本笔）。并发提交仅一笔可成功。`,
        })
      } else if (url === '/license/confirm') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        reconcile(state, audit)
        const reservation = getHeldReservation(packageId, state)
        if (!reservation) {
          const consumed = state.reservations.find(
            (item) => item.packageId === packageId && item.status === 'consumed',
          )
          if (consumed) {
            // 核销重试幂等：已核销直接成功返回，不多占
            audit({
              packageId,
              action: '许可核销重试',
              target: packageItem.code,
              operator: '当前用户',
              detail: '许可已核销，重复请求直接读回既有许可，额度不重复扣减。',
            })
            return state
          }
          throw new Error('没有在持预占，不能核销；请先预占额度')
        }
        reservation.attempts += 1
        reservation.lastAttemptAt = now()
        if (!isRouteFullyApproved(packageItem)) {
          audit({
            packageId,
            action: '许可核销失败',
            target: packageItem.code,
            operator: '系统核对链',
            detail: '审批路线存在未通过或失效步骤，预占保留，可在补签后重试核销。',
          })
          throw new Error('审批路线未全部通过，核销失败，预占已保留，可重试')
        }
        if (packageItem.frozenBaseline?.driftChanges.length) {
          audit({
            packageId,
            action: '许可核销失败',
            target: packageItem.code,
            operator: '系统核对链',
            detail: '冻结对象与核销基线不一致，预占保留，可在重新生成路线并补签后重试。',
          })
          throw new Error('冻结对象已变化，核销失败，预占已保留，可重试')
        }
        reservation.status = 'consumed'
        packageItem.quotaUsed += reservation.amount
        packageItem.status = 'licensed'
        const baseline = packageItem.frozenBaseline
        const licenseNo = `EC-LIC-${new Date().getFullYear()}-${String(state.licenses.length + 1).padStart(3, '0')}`
        state.licenses.push({
          id: `license-${crypto.randomUUID()}`,
          packageId,
          ruleId: reservation.ruleId,
          reservationId: reservation.id,
          amount: reservation.amount,
          status: 'active',
          licenseNo,
          issuedAt: now(),
          baseline: baseline
            ? JSON.parse(JSON.stringify(baseline)) as typeof baseline
            : buildFrozenBaseline(packageItem, state.files, '当前用户'),
          drifts: [],
        })
        audit({
          packageId,
          action: '许可核销',
          target: packageItem.code,
          operator: '当前用户',
          detail: `生成许可记录 ${licenseNo}，核销额度 ${reservation.amount}，预占转为已核销。`,
        })
      } else if (url === '/license/withdraw') {
        const packageId = String(payload.packageId)
        const reason = String(payload.reason ?? '人工撤回')
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        const license = getPackageLicense(packageId, state)
        if (!license) throw new Error('不存在许可记录')
        if (license.status !== 'pending-review') {
          throw new Error('仅待复核许可可以人工撤回并释放额度')
        }
        license.status = 'withdrawn'
        license.withdrawnAt = now()
        license.withdrawReason = reason
        const reservation = state.reservations.find((item) => item.id === license.reservationId)
        if (reservation) {
          reservation.status = 'released'
          reservation.releasedAt = now()
          reservation.releaseReason = reason
        }
        packageItem.quotaUsed = Math.max(0, packageItem.quotaUsed - license.amount)
        packageItem.status = 'returned'
        packageItem.frozenBaseline = undefined
        // 撤回释放后需重走核对链：重置步骤状态，保留历史意见
        packageItem.approvalRoute = packageItem.approvalRoute.map((step, index) => ({
          ...step,
          status: index === 0 ? 'active' : 'waiting',
        }))
        audit({
          packageId,
          action: '人工撤回许可',
          target: `${packageItem.code} / ${license.licenseNo}`,
          operator: '当前用户',
          detail: `待复核许可人工撤回，释放额度 ${license.amount}，原因：${reason}。`,
        })
      } else if (url === '/comment/add') {
        state.comments.unshift({
          ...(payload.comment as Omit<ReviewComment, 'id' | 'createdAt'>),
          id: `comment-${crypto.randomUUID()}`,
          createdAt: now(),
        })
      } else if (url === '/audit/add') {
        audit(payload.entry as Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>)
      } else if (url === '/workspace/reset') {
        return resetWorkspace()
      } else {
        throw new Error(`未实现的本地接口：${url}`)
      }

      return state
    })

    return { data }
  } catch (error) {
    if (error instanceof ChainConflictError) {
      return { error: error.payload }
    }
    return {
      error: {
        status: 400,
        error: error instanceof Error ? error.message : '本地操作失败',
      },
    }
  }
}

export const workspaceApi = createApi({
  reducerPath: 'workspaceApi',
  baseQuery: mockBaseQuery,
  tagTypes: ['Workspace'],
  endpoints: (builder) => ({
    getWorkspace: builder.query<WorkspaceState, void>({
      query: () => ({ url: '/workspace', method: 'GET' }),
      providesTags: ['Workspace'],
    }),
    savePackage: builder.mutation<
      WorkspaceState,
      { packageId: string; patch: Partial<MaterialPackage> }
    >({
      query: (body) => ({ url: '/package/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackage: builder.mutation<
      WorkspaceState,
      {
        package: Omit<
          MaterialPackage,
          'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
        >
      }
    >({
      query: (body) => ({ url: '/package/create', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    saveFile: builder.mutation<WorkspaceState, { file: MaterialFile }>({
      query: (body) => ({ url: '/file/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addFileVersion: builder.mutation<
      WorkspaceState,
      { packageId: string; fileId: string; label: string; pageCount: number; summary: string }
    >({
      query: (body) => ({ url: '/file/version/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    setReferenceVersion: builder.mutation<
      WorkspaceState,
      { fileId: string; versionId: string }
    >({
      query: (body) => ({ url: '/file/reference', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    savePageReview: builder.mutation<
      WorkspaceState,
      { fileId: string; versionId: string; page: PageReview }
    >({
      query: (body) => ({ url: '/page/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    validatePackage: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/package/validate', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackageVersion: builder.mutation<
      WorkspaceState,
      { packageId: string; label: string; summary: string }
    >({
      query: (body) => ({ url: '/package/version', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    submitApproval: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/approval/submit', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    decideApproval: builder.mutation<
      WorkspaceState,
      { packageId: string; stepId: string; decision: 'approve' | 'return'; comment: string }
    >({
      query: (body) => ({ url: '/approval/decide', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    reserveQuota: builder.mutation<
      WorkspaceState,
      { packageId: string; amount: number; clientToken: string; owner?: string }
    >({
      query: (body) => ({ url: '/quota/reserve', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    confirmLicense: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/license/confirm', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    withdrawLicense: builder.mutation<
      WorkspaceState,
      { packageId: string; reason: string }
    >({
      query: (body) => ({ url: '/license/withdraw', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addComment: builder.mutation<
      WorkspaceState,
      { comment: Omit<ReviewComment, 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/comment/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addAudit: builder.mutation<
      WorkspaceState,
      { entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/audit/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    resetWorkspace: builder.mutation<WorkspaceState, void>({
      query: () => ({ url: '/workspace/reset', method: 'POST' }),
      invalidatesTags: ['Workspace'],
    }),
  }),
})

export const {
  useGetWorkspaceQuery,
  useSavePackageMutation,
  useCreatePackageMutation,
  useSaveFileMutation,
  useAddFileVersionMutation,
  useSetReferenceVersionMutation,
  useSavePageReviewMutation,
  useValidatePackageMutation,
  useCreatePackageVersionMutation,
  useSubmitApprovalMutation,
  useDecideApprovalMutation,
  useReserveQuotaMutation,
  useConfirmLicenseMutation,
  useWithdrawLicenseMutation,
  useAddCommentMutation,
  useAddAuditMutation,
  useResetWorkspaceMutation,
} = workspaceApi

import { createApi } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn } from '@reduxjs/toolkit/query/react'
import type {
  FreezeBaseline,
  MaterialFile,
  MaterialPackage,
  PageReview,
  ReviewComment,
  WorkspaceState,
} from '@/types/domain'
import { loadWorkspace, resetWorkspace, saveWorkspace } from '@/services/storage'
import { createApprovalRoute, findApplicableRule, validatePackage } from '@/services/rules'
import {
  applyChangeChain,
  buildFreezeBaseline,
  clientId,
  clientLabel,
  findActiveLicense,
  findReservation,
  poolRemainingMap,
  ruleQuotaPool,
} from '@/services/chain'

type MockRequest = {
  url: string
  method: 'GET' | 'POST'
  body?: unknown
}

type MockError = {
  status: number
  error: string
  code?: string
  holder?: string
  holderLabel?: string
  remaining?: number
  amount?: number
  reservationId?: string
}

const wait = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms))
const now = () => new Date().toISOString()

class MockApiError extends Error {
  payload: Partial<Omit<MockError, 'error'>>
  constructor(message: string, payload: Partial<Omit<MockError, 'error'>> = {}) {
    super(message)
    this.payload = payload
  }
}

/**
 * 本地模拟服务的写入串行锁：两个窗口（标签页）在同一浏览器内
 * 并发提交额度预占时，处理顺序被拉开，结合状态检查保证只有一个成功。
 */
let writeChain: Promise<unknown> = Promise.resolve()
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task)
  writeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** 写入后统一执行冻结对象核对链并刷新额度口径下的校验结论 */
function refreshAfterWrite(
  state: WorkspaceState,
  audit: (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => void,
  packageId?: string,
) {
  applyChangeChain(state, audit)
  const remainingByRule = poolRemainingMap(state)
  if (packageId) {
    state.findings = [
      ...state.findings.filter((item) => item.packageId !== packageId),
      ...validatePackage(
        state.packages.find((item) => item.id === packageId)!,
        state.files,
        state.rules,
        state.packages.find((item) => item.id === packageId)?.matchedRuleId
          ? remainingByRule[
              state.packages.find((item) => item.id === packageId)!.matchedRuleId!
            ]
          : undefined,
      ),
    ]
  }
}

export const mockBaseQuery: BaseQueryFn<MockRequest, unknown, MockError> = ({ url, body }) =>
  serialize(async () => {
    await wait()
    let state = loadWorkspace()
    const payload = (body ?? {}) as Record<string, unknown>
    const audit = (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => {
      state.audit.unshift({ ...entry, id: `audit-${crypto.randomUUID()}`, createdAt: now() })
    }

    try {
      if (url === '/workspace') return { data: state }

      if (url === '/package/save') {
        const packageId = String(payload.packageId)
        const patch = payload.patch as Partial<MaterialPackage>
        const current = state.packages.find((item) => item.id === packageId)
        if (!current) throw new Error('资料包不存在')
        Object.assign(current, patch, { updatedAt: now() })
        current.matchedRuleId = findApplicableRule(current, state.rules)?.id
        audit({
          packageId,
          action: '更新资料包',
          target: current.code,
          operator: '当前用户',
          detail: '更新收件方、最终用途、声明或技术参数。',
        })
        refreshAfterWrite(state, audit, packageId)
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
          routeInvalidated: false,
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
        audit({
          packageId,
          action: '上传文件版本',
          target: `${file.name} ${label}`,
          operator: '当前用户',
          detail: summary,
        })
        refreshAfterWrite(state, audit, packageId)
      } else if (url === '/file/reference') {
        const fileId = String(payload.fileId)
        const versionId = String(payload.versionId)
        const file = state.files.find((item) => item.id === fileId)
        if (!file) throw new Error('文件不存在')
        file.referencedVersionId = versionId
        audit({
          packageId: file.packageId,
          action: '选择引用版本',
          target: file.name,
          operator: '当前用户',
          detail: `引用版本调整为 ${file.versions.find((item) => item.id === versionId)?.label ?? versionId}。`,
        })
        refreshAfterWrite(state, audit, file.packageId)
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
        refreshAfterWrite(state, audit, file.packageId)
      } else if (url === '/package/validate') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        refreshAfterWrite(state, audit, packageId)
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
        audit({
          packageId,
          action: '创建资料包版本',
          target: `${packageItem.code} ${label}`,
          operator: '当前用户',
          detail: summary,
        })
        refreshAfterWrite(state, audit, packageId)
      } else if (url === '/approval/submit') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        if (packageItem.status === 'licensed' || packageItem.status === 'license-review') {
          throw new Error('已核销许可，不能重复提交审批')
        }
        const rule = findApplicableRule(packageItem, state.rules)
        if (!rule) throw new Error('未匹配到许可规则')
        const pool = ruleQuotaPool(state, rule.id)
        if (pool.remaining <= 0 && !findReservation(state, packageId)) {
          throw new Error(`规则额度池已用尽，剩余 ${pool.remaining}，无法提交审批`)
        }

        // 提交审批即冻结：资料包版本、文件引用版本（含内容指纹）与声明
        const wasInvalidated = packageItem.routeInvalidated === true
        packageItem.matchedRuleId = rule.id
        packageItem.status = 'reviewing'
        packageItem.currentRound += 1
        const baseline: FreezeBaseline = buildFreezeBaseline(packageItem, state.files, '当前用户')
        packageItem.freezeBaseline = baseline
        packageItem.routeInvalidated = false
        packageItem.routeInvalidatedChanges = []
        // 冻结变化导致的重新发起：已通过步骤保留，仅重排未完成步骤
        packageItem.approvalRoute =
          wasInvalidated && packageItem.approvalRoute.length
            ? packageItem.approvalRoute
            : createApprovalRoute(rule.approvalLevel)
        audit({
          packageId,
          action: '提交审批并冻结基线',
          target: packageItem.code,
          operator: '当前用户',
          detail: `按 ${rule.name} 生成第 ${packageItem.currentRound} 轮路线；冻结资料包版本 ${
            baseline.packageVersionLabel
          }、${Object.keys(baseline.fileReferences).length} 个文件引用版本与 ${
            baseline.declarations.length
          } 项声明。`,
        })
        refreshAfterWrite(state, audit, packageId)
      } else if (url === '/approval/decide') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        const step = packageItem.approvalRoute.find((item) => item.id === String(payload.stepId))
        if (!step || step.status !== 'active') throw new Error('当前步骤不可审批')
        const decision = String(payload.decision)
        step.comment = String(payload.comment ?? '')
        step.decidedAt = now()
        if (decision === 'return') {
          step.status = 'returned'
          packageItem.status = 'returned'
        } else {
          step.status = 'approved'
          const next = packageItem.approvalRoute.find((item) => item.order === step.order + 1)
          if (next) next.status = 'active'
          else {
            packageItem.status = findReservation(state, packageId) ? 'quota-reserved' : 'approved'
          }
        }
        audit({
          packageId,
          action: decision === 'return' ? '审批退回' : '审批通过',
          target: `${packageItem.code} / ${step.role}`,
          operator: step.assignee,
          detail: step.comment || '无补充意见。',
        })
        refreshAfterWrite(state, audit, packageId)
      } else if (url === '/quota/reserve') {
        const packageId = String(payload.packageId)
        const amount = Number(payload.amount)
        const holder = String(payload.clientId ?? clientId)
        const holderLabelText = String(payload.clientLabel ?? clientLabel)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('预占额度必须大于 0')
        const reservation = findReservation(state, packageId)
        if (reservation) {
          const pool = ruleQuotaPool(state, reservation.ruleId)
          if (reservation.holder === holder) {
            audit({
              packageId,
              action: '额度预占重试',
              target: packageItem.code,
              operator: holderLabelText,
              detail: `预占 ${reservation.amount} 仍由本窗口持有，幂等返回，不重复占用。`,
            })
          } else {
            throw new MockApiError(`额度已被其他窗口预占：${reservation.holderLabel}`, {
              status: 409,
              code: 'quota-occupied',
              holder: reservation.holder,
              holderLabel: reservation.holderLabel,
              remaining: pool.remaining,
              amount: reservation.amount,
              reservationId: reservation.id,
            })
          }
        } else {
          if (
            packageItem.status !== 'approved' &&
            !(
              packageItem.status === 'reviewing' &&
              packageItem.approvalRoute.length > 0 &&
              !packageItem.routeInvalidated &&
              packageItem.approvalRoute.every((s) => s.status === 'approved')
            )
          ) {
            throw new Error('审批全部通过且基线有效后才允许预占额度')
          }
          const rule = state.rules.find((item) => item.id === packageItem.matchedRuleId)
          if (!rule) throw new Error('未匹配到许可规则')
          const pool = ruleQuotaPool(state, rule.id)
          if (amount > pool.remaining) {
            throw new MockApiError(`规则额度池剩余 ${pool.remaining}，无法预占 ${amount}`, {
              status: 409,
              code: 'quota-insufficient',
              remaining: pool.remaining,
              amount,
            })
          }
          const created = {
            id: `reservation-${crypto.randomUUID()}`,
            packageId,
            ruleId: rule.id,
            amount,
            holder,
            holderLabel: holderLabelText,
            status: 'held' as const,
            attempts: 0,
            lastError: '',
            createdAt: now(),
            heldAt: now(),
          }
          state.reservations.push(created)
          packageItem.reservationId = created.id
          packageItem.status = 'quota-reserved'
          audit({
            packageId,
            action: '额度预占',
            target: packageItem.code,
            operator: holderLabelText,
            detail: `预占 ${amount}，规则「${rule.name}」池内剩余 ${pool.remaining - amount}，等待核销。`,
          })
        }
        refreshAfterWrite(state, audit, packageId)
      } else if (url === '/quota/settle') {
        const packageId = String(payload.packageId)
        const simulateFailure = Boolean(payload.simulateFailure)
        const holder = String(payload.clientId ?? clientId)
        const holderLabelText = String(payload.clientLabel ?? clientLabel)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        const heldReservation = findReservation(state, packageId)
        const ownedReservation =
          heldReservation ??
          (packageItem.reservationId
            ? state.reservations.find((item) => item.id === packageItem.reservationId)
            : undefined)
        if (!ownedReservation) throw new Error('不存在有效预占，请先预占额度')
        if (heldReservation && heldReservation.holder !== holder) {
          const pool = ruleQuotaPool(state, heldReservation.ruleId)
          throw new MockApiError(`预占由 ${heldReservation.holderLabel} 持有，当前窗口不能核销`, {
            status: 409,
            code: 'quota-occupied',
            holder: heldReservation.holder,
            holderLabel: heldReservation.holderLabel,
            remaining: pool.remaining,
            amount: heldReservation.amount,
            reservationId: heldReservation.id,
          })
        }
        const reservation = ownedReservation

        const existing = state.licenses.find(
          (license) => license.quotaReservationId === reservation.id,
        )
        if (existing) {
          audit({
            packageId,
            action: '许可核销重试',
            target: packageItem.code,
            operator: holderLabelText,
            detail: '该预占已核销，幂等返回既有许可记录，不重复扣减。',
          })
        } else if (packageItem.routeInvalidated) {
          throw new Error('冻结基线已变化、审批路线失效，请重新发起并补签后再核销')
        } else {
          reservation.attempts += 1
          if (simulateFailure) {
            reservation.lastError = '许可登记服务暂时不可用，预占保留，可重试核销。'
            audit({
              packageId,
              action: '许可核销失败',
              target: packageItem.code,
              operator: holderLabelText,
              detail: `第 ${reservation.attempts} 次核销失败：${reservation.lastError}`,
            })
            saveWorkspace(state)
            throw new MockApiError(reservation.lastError, {
              status: 503,
              code: 'settle-failed',
              reservationId: reservation.id,
              amount: reservation.amount,
              remaining: ruleQuotaPool(state, reservation.ruleId).remaining,
            })
          }
          if (!packageItem.freezeBaseline) throw new Error('缺少冻结基线，不能核销')
          const settledAt = now()
          reservation.status = 'settled'
          reservation.settledAt = settledAt
          reservation.lastError = ''
          state.licenses.push({
            id: `license-${crypto.randomUUID()}`,
            packageId,
            packageCode: packageItem.code,
            ruleId: reservation.ruleId,
            amount: reservation.amount,
            quotaReservationId: reservation.id,
            baseline: packageItem.freezeBaseline,
            status: 'active',
            createdAt: settledAt,
            reviewReason: '',
            changes: [],
          })
          packageItem.status = 'licensed'
          packageItem.quotaUsed += reservation.amount
          const pool = ruleQuotaPool(state, reservation.ruleId)
          audit({
            packageId,
            action: '许可核销',
            target: packageItem.code,
            operator: holderLabelText,
            detail: `预占 ${reservation.amount} 核销生成许可记录，规则池剩余 ${pool.remaining}（已核销 ${pool.used}、预占 ${pool.held}）。`,
          })
        }
        refreshAfterWrite(state, audit, packageId)
      } else if (url === '/license/revoke') {
        const packageId = String(payload.packageId)
        const reason = String(payload.reason ?? '人工撤回')
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        const license = findActiveLicense(state, packageId)
        const reservation =
          (packageItem.reservationId
            ? state.reservations.find((item) => item.id === packageItem.reservationId)
            : undefined) ?? findReservation(state, packageId)
        if (!license && !reservation) throw new Error('没有可撤回的许可或预占')

        const releasedAt = now()
        if (license && license.status !== 'revoked') {
          license.status = 'revoked'
          license.revokedAt = releasedAt
          license.revokeReason = reason
          packageItem.quotaUsed = Math.max(0, packageItem.quotaUsed - license.amount)
        }
        if (reservation && reservation.status === 'held') {
          reservation.status = 'released'
          reservation.releasedAt = releasedAt
          reservation.releaseReason = reason
        }
        packageItem.status = 'returned'
        packageItem.reservationId = undefined
        packageItem.routeInvalidated = true
        packageItem.routeInvalidatedChanges = [
          {
            kind: 'declaration',
            target: '人工撤回',
            before: '许可/预占有效',
            after: '已撤回并释放额度',
            at: releasedAt,
          },
        ]
        const pool = packageItem.matchedRuleId
          ? ruleQuotaPool(state, packageItem.matchedRuleId)
          : undefined
        audit({
          packageId,
          action: '人工撤回许可',
          target: packageItem.code,
          operator: '当前用户',
          detail: `${reason}。许可撤回，额度释放${pool ? `，规则池剩余 ${pool.remaining}` : ''}；请按当前冻结对象重新发起审批。`,
        })
        refreshAfterWrite(state, audit, packageId)
      } else if (url === '/license/reconfirm') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        const license = findActiveLicense(state, packageId)
        if (!license) throw new Error('没有待复核的许可')
        // 人工复核通过：以当前资料包版本、引用版本和声明重新冻结基线，额度保持不释放
        const baseline = buildFreezeBaseline(packageItem, state.files, '当前用户')
        license.status = 'active'
        license.baseline = baseline
        license.reviewReason = ''
        license.changes = []
        license.reviewChangedAt = undefined
        packageItem.freezeBaseline = baseline
        packageItem.status = 'licensed'
        packageItem.routeInvalidated = false
        packageItem.routeInvalidatedChanges = []
        audit({
          packageId,
          action: '许可复核通过',
          target: packageItem.code,
          operator: '当前用户',
          detail: `人工复核确认，按 ${baseline.packageVersionLabel} 与当前文件引用重新冻结基线，额度维持占用。`,
        })
        refreshAfterWrite(state, audit, packageId)
      } else if (url === '/comment/add') {
        state.comments.unshift({
          ...(payload.comment as Omit<ReviewComment, 'id' | 'createdAt'>),
          id: `comment-${crypto.randomUUID()}`,
          createdAt: now(),
        })
      } else if (url === '/audit/add') {
        audit(payload.entry as Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>)
      } else if (url === '/workspace/reset') {
        state = resetWorkspace()
        return { data: state }
      } else {
        throw new Error(`未实现的本地接口：${url}`)
      }

      saveWorkspace(state)
      return { data: state }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : '本地操作失败'
      const payload: MockError =
        error instanceof MockApiError
          ? { status: 400, ...error.payload, error: messageText }
          : { status: 400, error: messageText }
      return { error: payload }
    }
  })

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
      { packageId: string; amount: number; clientId?: string; clientLabel?: string }
    >({
      query: (body) => ({ url: '/quota/reserve', method: 'POST', body: { ...body, clientId, clientLabel } }),
      invalidatesTags: ['Workspace'],
    }),
    settleQuota: builder.mutation<
      WorkspaceState,
      { packageId: string; simulateFailure?: boolean; clientId?: string; clientLabel?: string }
    >({
      query: (body) => ({ url: '/quota/settle', method: 'POST', body: { ...body, clientId, clientLabel } }),
      invalidatesTags: ['Workspace'],
    }),
    revokeLicense: builder.mutation<WorkspaceState, { packageId: string; reason: string }>({
      query: (body) => ({ url: '/license/revoke', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    reconfirmLicense: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/license/reconfirm', method: 'POST', body }),
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

export { clientId, clientLabel }

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
  useSettleQuotaMutation,
  useRevokeLicenseMutation,
  useReconfirmLicenseMutation,
  useAddCommentMutation,
  useAddAuditMutation,
  useResetWorkspaceMutation,
} = workspaceApi

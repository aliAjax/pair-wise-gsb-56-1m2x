import type {
  ApprovalStep,
  FileVersion,
  FreezeBaseline,
  FreezeChange,
  LicenseRecord,
  LicenseRule,
  MaterialFile,
  MaterialPackage,
  QuotaReservation,
  WorkspaceState,
} from '@/types/domain'
import { createApprovalRoute, findApplicableRule } from './rules'

const now = () => new Date().toISOString()

/**
 * 每个窗口（标签页）一个独立标识：模块在页面加载时初始化，
 * 两个窗口同时发起额度预占时携带不同 holder，用于互斥与读回。
 */
export const clientId = crypto.randomUUID()
export const clientLabel = `窗口-${clientId.slice(0, 4)}`

/** 引用版本逐页核对内容指纹：分类、受控、脱敏、备注任一变化都能检出 */
export function versionContentFingerprint(version: FileVersion): string {
  const rows = version.pages.map(
    (page) =>
      `${page.page}|${page.category}|${page.controlled ? 1 : 0}|${
        page.desensitized ? 1 : 0
      }|${page.note}`,
  )
  return `fp-${btoa(unescape(encodeURIComponent(rows.join('##')))).slice(0, 24)}`
}

/** 提交审批时按当前资料包版本、文件引用版本和声明冻结核对基线 */
export function buildFreezeBaseline(
  packageItem: MaterialPackage,
  files: MaterialFile[],
  frozenBy: string,
): FreezeBaseline {
  const packageVersion = packageItem.versions.at(-1)
  const fileReferences: FreezeBaseline['fileReferences'] = {}
  files
    .filter((file) => file.packageId === packageItem.id)
    .forEach((file) => {
      const version =
        file.versions.find((item) => item.id === file.referencedVersionId) ??
        file.versions.find((item) => item.id === file.activeVersionId) ??
        file.versions.at(-1)
      if (!packageVersion || !version) return
      fileReferences[file.id] = {
        name: file.name,
        versionId: version.id,
        label: version.label,
        hash: version.hash,
        contentFingerprint: versionContentFingerprint(version),
      }
    })
  return {
    frozenAt: now(),
    frozenBy,
    round: packageItem.currentRound,
    packageVersionId: packageVersion?.id ?? '',
    packageVersionLabel: packageVersion?.label ?? '',
    fileReferences,
    declarations: [...packageItem.declarations],
  }
}

function sameSet(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

/** 比对冻结基线与当前对象，返回全部变化项 */
export function detectFreezeDrift(
  baseline: FreezeBaseline,
  packageItem: MaterialPackage,
  files: MaterialFile[],
): FreezeChange[] {
  const changes: FreezeChange[] = []
  const stamp = now()
  const currentVersion = packageItem.versions.at(-1)

  if (currentVersion && currentVersion.id !== baseline.packageVersionId) {
    changes.push({
      kind: 'package-version',
      target: '资料包版本',
      before: baseline.packageVersionLabel,
      after: currentVersion.label,
      at: stamp,
    })
  } else if (currentVersion) {
    // 资料包字段可在不新建版本的情况下直接修改，按冻结快照逐字段比对
    const snapshot = currentVersion.snapshot
    const fieldLabels: Array<[keyof MaterialPackage, string]> = [
      ['title', '资料包名称'],
      ['category', '资料分类'],
      ['destination', '国家地区'],
      ['endUse', '最终用途'],
      ['technologyTags', '技术参数'],
      ['personnelScopes', '人员范围'],
    ]
    const snapshotRecord = snapshot as unknown as Record<string, string | string[]>
    const packageRecord = packageItem as unknown as Record<string, string | string[]>
    fieldLabels.forEach(([field, label]) => {
      const before = snapshotRecord[field]
      const after = packageRecord[field]
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes.push({
          kind: 'package-version',
          target: label,
          before: Array.isArray(before) ? before.join('、') || '空' : String(before),
          after: Array.isArray(after) ? after.join('、') || '空' : String(after),
          at: stamp,
        })
      }
    })
  }

  if (!sameSet(baseline.declarations, packageItem.declarations)) {
    changes.push({
      kind: 'declaration',
      target: '声明清单',
      before: baseline.declarations.join('、') || '空',
      after: packageItem.declarations.join('、') || '空',
      at: stamp,
    })
  }

  const packageFiles = files.filter((file) => file.packageId === packageItem.id)
  packageFiles.forEach((file) => {
    const frozen = baseline.fileReferences[file.id]
    const referenced = file.versions.find((item) => item.id === file.referencedVersionId)
    if (!frozen) {
      if (referenced) {
        changes.push({
          kind: 'file-reference',
          target: file.name,
          before: '冻结时无引用',
          after: `${referenced.label}（新增引用）`,
          at: stamp,
        })
      }
      return
    }
    if (!referenced) {
      changes.push({
        kind: 'file-reference',
        target: frozen.name,
        before: `${frozen.label}（${frozen.hash}）`,
        after: '引用版本已移除',
        at: stamp,
      })
      return
    }
    if (referenced.id !== frozen.versionId) {
      changes.push({
        kind: 'file-reference',
        target: frozen.name,
        before: `${frozen.label}（${frozen.hash}）`,
        after: `${referenced.label}（${referenced.hash}）`,
        at: stamp,
      })
    } else if (versionContentFingerprint(referenced) !== frozen.contentFingerprint) {
      changes.push({
        kind: 'file-content',
        target: `${frozen.name} ${frozen.label}`,
        before: frozen.contentFingerprint,
        after: versionContentFingerprint(referenced),
        at: stamp,
      })
    }
  })
  Object.entries(baseline.fileReferences).forEach(([fileId, frozen]) => {
    if (!packageFiles.some((file) => file.id === fileId)) {
      changes.push({
        kind: 'file-reference',
        target: frozen.name,
        before: `${frozen.label}（${frozen.hash}）`,
        after: '文件已从资料包移除',
        at: stamp,
      })
    }
  })

  return changes
}

/**
 * 重新生成审批路线：已通过步骤保留（标记 carriedOver），未完成步骤重排；
 * 若全部步骤都已通过（核销/撤回或整体失效后重提），末步重新打开要求确认。
 */
export function rebuildRoutePreservingApprovals(
  existing: ApprovalStep[],
  rule: LicenseRule,
): ApprovalStep[] {
  const template = createApprovalRoute(rule.approvalLevel)
  const approved = existing.filter((step) => step.status === 'approved')
  let resumeIndex = 0
  const rebuilt = template.map((step, index) => {
    const prior = approved[index]
    if (prior && prior.level === step.level && index === resumeIndex) {
      resumeIndex += 1
      return { ...step, id: prior.id, status: 'approved' as const, comment: prior.comment, decidedAt: prior.decidedAt, carriedOver: true }
    }
    return { ...step, status: index === resumeIndex ? ('active' as const) : ('waiting' as const) }
  })
  // 全部步骤都已通过（整体失效后重提/撤回重提）：末步重新打开要求确认
  if (resumeIndex >= rebuilt.length) {
    const last = rebuilt.at(-1)
    if (last) {
      last.status = 'active'
      last.carriedOver = true
      last.comment = `${last.comment}（冻结基线变化后需重新确认）`.trim()
    }
  }
  return rebuilt
}

export interface ChainEffect {
  packageItem: MaterialPackage
  changes: FreezeChange[]
  type: 'route-invalidated' | 'license-review'
}

type AuditFn = (entry: {
  packageId?: string
  action: string
  target: string
  operator: string
  detail: string
}) => void

/**
 * 任何写操作之后执行：冻结对象变化时——
 * 审批中/已批准/已预占：未完成路线即时失效，已通过步骤保留并重新生成路线；
 * 已核销：许可转待复核，额度不释放。
 */
export function applyChangeChain(state: WorkspaceState, audit: AuditFn): ChainEffect[] {
  const effects: ChainEffect[] = []
  for (const packageItem of state.packages) {
    if (!packageItem.freezeBaseline) continue
    const changes = detectFreezeDrift(packageItem.freezeBaseline, packageItem, state.files)
    if (!changes.length) continue
    const summary = changes
      .map((change) => `${change.target}：${change.before} → ${change.after}`)
      .join('；')

    if (packageItem.status === 'licensed' || packageItem.status === 'license-review') {
      const license = state.licenses.find(
        (item) =>
          item.packageId === packageItem.id &&
          (item.status === 'active' || item.status === 'pending-review'),
      )
      if (!license) continue
      if (license.status === 'active') {
        license.status = 'pending-review'
        license.reviewReason = '核销后冻结对象发生变化，许可转为待复核。'
        license.reviewChangedAt = now()
        license.changes = changes
        packageItem.status = 'license-review'
        effects.push({ packageItem, changes, type: 'license-review' })
        audit({
          packageId: packageItem.id,
          action: '许可转待复核',
          target: packageItem.code,
          operator: '系统核对链',
          detail: `${summary}。许可额度保持占用，等待人工复核或撤回。`,
        })
      } else {
        license.changes = changes
        license.reviewChangedAt = now()
      }
      continue
    }

    if (
      packageItem.status === 'reviewing' ||
      packageItem.status === 'approved' ||
      packageItem.status === 'quota-reserved'
    ) {
      if (packageItem.routeInvalidated) {
        packageItem.routeInvalidatedChanges = changes
        continue
      }
      const rule =
        state.rules.find((item) => item.id === packageItem.matchedRuleId) ??
        findApplicableRule(packageItem, state.rules)
      if (rule) {
        packageItem.approvalRoute = rebuildRoutePreservingApprovals(packageItem.approvalRoute, rule)
      }
      packageItem.status = 'reviewing'
      packageItem.routeInvalidated = true
      packageItem.routeInvalidatedChanges = changes
      effects.push({ packageItem, changes, type: 'route-invalidated' })
      audit({
        packageId: packageItem.id,
        action: '冻结变化致路线失效',
        target: packageItem.code,
        operator: '系统核对链',
        detail: `${summary}。未完成审批步骤即时失效，已通过步骤保留并重新生成路线。`,
      })
    }
  }
  return effects
}

export interface RuleQuotaPool {
  ruleId: string
  limit: number
  used: number
  held: number
  remaining: number
  heldReservations: QuotaReservation[]
}

/** 规则额度池：已核销（含待复核）计占用，预占计持有，撤回/释放后扣除 */
export function ruleQuotaPool(state: WorkspaceState, ruleId: string): RuleQuotaPool {
  const rule = state.rules.find((item) => item.id === ruleId)
  const used = state.licenses
    .filter((item) => item.ruleId === ruleId && item.status !== 'revoked')
    .reduce((total, item) => total + item.amount, 0)
  const heldReservations = state.reservations.filter(
    (item) => item.ruleId === ruleId && item.status === 'held',
  )
  const held = heldReservations.reduce((total, item) => total + item.amount, 0)
  const limit = rule?.quotaLimit ?? 0
  return { ruleId, limit, used, held, remaining: limit - used - held, heldReservations }
}

export function poolRemainingMap(state: WorkspaceState): Record<string, number> {
  return Object.fromEntries(state.rules.map((rule) => [rule.id, ruleQuotaPool(state, rule.id).remaining]))
}

export function findReservation(
  state: WorkspaceState,
  packageId: string,
): QuotaReservation | undefined {
  return state.reservations.find((item) => item.packageId === packageId && item.status === 'held')
}

export function findActiveLicense(
  state: WorkspaceState,
  packageId: string,
): LicenseRecord | undefined {
  return state.licenses.find(
    (item) =>
      item.packageId === packageId &&
      (item.status === 'active' || item.status === 'pending-review'),
  )
}

/** 旧数据迁移：按当前引用版本回填冻结基线，已核销数据补齐许可记录 */
export function migrateWorkspace(raw: Partial<WorkspaceState> | null): WorkspaceState {
  const state = {
    packages: raw?.packages ?? [],
    files: raw?.files ?? [],
    rules: raw?.rules ?? [],
    findings: raw?.findings ?? [],
    comments: raw?.comments ?? [],
    audit: raw?.audit ?? [],
    reservations: raw?.reservations ?? [],
    licenses: raw?.licenses ?? [],
  } as WorkspaceState

  for (const packageItem of state.packages) {
    packageItem.routeInvalidated ??= false
    const hasRoute = packageItem.approvalRoute?.length > 0
    if (!packageItem.freezeBaseline && hasRoute && packageItem.status !== 'draft') {
      packageItem.freezeBaseline = buildFreezeBaseline(packageItem, state.files, '系统回填')
    }
    const existingLicense = state.licenses.some(
      (license) => license.packageId === packageItem.id,
    )
    if (
      (packageItem.status === 'licensed' || packageItem.status === 'license-review') &&
      !existingLicense &&
      packageItem.freezeBaseline
    ) {
      const amount = packageItem.quotaUsed
      const reservationId = `reservation-${crypto.randomUUID()}`
      state.reservations.push({
        id: reservationId,
        packageId: packageItem.id,
        ruleId: packageItem.matchedRuleId ?? '',
        amount,
        holder: '历史数据',
        holderLabel: '历史核销',
        status: 'settled',
        attempts: 1,
        lastError: '',
        createdAt: packageItem.updatedAt,
        heldAt: packageItem.updatedAt,
        settledAt: packageItem.updatedAt,
      })
      state.licenses.push({
        id: `license-${crypto.randomUUID()}`,
        packageId: packageItem.id,
        packageCode: packageItem.code,
        ruleId: packageItem.matchedRuleId ?? '',
        amount,
        quotaReservationId: reservationId,
        baseline: packageItem.freezeBaseline,
        status: 'active',
        createdAt: packageItem.updatedAt,
        reviewReason: '',
        changes: [],
      })
      packageItem.reservationId = reservationId
    }
  }
  return state
}

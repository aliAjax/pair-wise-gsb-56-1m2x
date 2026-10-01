import type {
  ApprovalLevel,
  ApprovalStep,
  DriftChange,
  DriftKind,
  FrozenBaseline,
  LicenseRecord,
  MaterialFile,
  MaterialPackage,
  QuotaReservation,
  WorkspaceState,
} from '@/types/domain'
import { createApprovalRoute } from './rules'

const nowIso = () => new Date().toISOString()

const driftFieldLabels: Record<string, string> = {
  title: '资料包名称',
  category: '资料分类',
  destination: '国家或地区',
  endUse: '最终用途',
  technologyTags: '技术参数',
  personnelScopes: '人员范围',
}

/** 规则额度池：只统计在持预占与未撤回许可，历史 quotaUsed 与已释放预占不重复占用 */
export interface RuleQuotaPool {
  ruleId: string
  limit: number
  held: number
  consumed: number
  remaining: number
  holderDescriptions: { packageId: string; packageCode: string; owner: string; amount: number }[]
}

export function getRulePool(ruleId: string, state: WorkspaceState): RuleQuotaPool {
  const rule = state.rules.find((item) => item.id === ruleId)
  const limit = rule?.quotaLimit ?? 0
  const heldReservations = (state.reservations ?? []).filter(
    (item) => item.ruleId === ruleId && item.status === 'held',
  )
  const consumed = (state.licenses ?? [])
    .filter((item) => item.ruleId === ruleId && item.status !== 'withdrawn')
    .reduce((sum, item) => sum + item.amount, 0)
  const held = heldReservations.reduce((sum, item) => sum + item.amount, 0)
  return {
    ruleId,
    limit,
    held,
    consumed,
    remaining: limit - consumed - held,
    holderDescriptions: heldReservations.map((item) => ({
      packageId: item.packageId,
      packageCode:
        state.packages.find((pkg) => pkg.id === item.packageId)?.code ?? item.packageId,
      owner: item.owner,
      amount: item.amount,
    })),
  }
}

export function getHeldReservation(
  packageId: string,
  state: WorkspaceState,
): QuotaReservation | undefined {
  return (state.reservations ?? []).find(
    (item) => item.packageId === packageId && item.status === 'held',
  )
}

export function getPackageLicense(
  packageId: string,
  state: WorkspaceState,
): LicenseRecord | undefined {
  return (state.licenses ?? [])
    .filter((item) => item.packageId === packageId)
    .at(-1)
}

/** 提交审批时按当前资料包版本、文件引用版本和声明冻结核对基线 */
export function buildFrozenBaseline(
  packageItem: MaterialPackage,
  files: MaterialFile[],
  frozenBy: string,
  frozenAt = nowIso(),
): FrozenBaseline {
  const packageVersion = packageItem.versions.at(-1)
  return {
    packageVersionId: packageVersion?.id ?? '',
    packageLabel: packageVersion?.label ?? '未命名版本',
    frozenAt,
    frozenBy,
    declarations: [...packageItem.declarations],
    fileReferences: files
      .filter((file) => file.packageId === packageItem.id)
      .map((file) => {
        const version = file.versions.find((item) => item.id === file.referencedVersionId)
        return {
          fileId: file.id,
          fileName: file.name,
          versionId: file.referencedVersionId,
          versionLabel: version?.label ?? file.referencedVersionId,
        }
      }),
    driftChanges: [],
  }
}

function driftSignature(kind: DriftKind, target: string, after: string) {
  return `${kind}|${target}|${after}`
}

/**
 * 对照冻结基线检测冻结对象变化：资料包版本（含目的地/用途/技术参数等快照字段）、
 * 文件引用版本、声明。
 */
export function detectDrift(
  baseline: FrozenBaseline,
  packageItem: MaterialPackage,
  files: MaterialFile[],
): DriftChange[] {
  const detected: DriftChange[] = []
  const push = (kind: DriftKind, target: string, before: string, after: string) => {
    if (before === after) return
    detected.push({
      id: `drift-${crypto.randomUUID()}`,
      kind,
      target,
      before: before || '空',
      after: after || '空',
      detectedAt: nowIso(),
    })
  }

  const frozenVersion = packageItem.versions.find(
    (version) => version.id === baseline.packageVersionId,
  )
  const latestVersion = packageItem.versions.at(-1)
  if (latestVersion && latestVersion.id !== baseline.packageVersionId) {
    push(
      'package-version',
      '资料包版本',
      baseline.packageLabel,
      `${latestVersion.label}（冻结后新建版本）`,
    )
  }
  if (frozenVersion) {
    const snapshot = frozenVersion.snapshot
    const compareFields = ['title', 'category', 'destination', 'endUse'] as const
    compareFields.forEach((field) => {
      push(
        'package-version',
        driftFieldLabels[field],
        String(snapshot[field]),
        String(packageItem[field]),
      )
    })
    ;(['technologyTags', 'personnelScopes'] as const).forEach((field) => {
      push(
        'package-version',
        driftFieldLabels[field],
        snapshot[field].join('、'),
        packageItem[field].join('、'),
      )
    })
  }

  const beforeDeclarations = baseline.declarations.join('、')
  const afterDeclarations = packageItem.declarations.join('、')
  push('declaration', '申报声明', beforeDeclarations, afterDeclarations)

  const packageFiles = files.filter((file) => file.packageId === packageItem.id)
  baseline.fileReferences.forEach((reference) => {
    const file = packageFiles.find((item) => item.id === reference.fileId)
    const current = file?.versions.find((item) => item.id === file?.referencedVersionId)
    if (file && file.referencedVersionId !== reference.versionId) {
      push(
        'file-reference',
        reference.fileName,
        reference.versionLabel,
        current?.label ?? file.referencedVersionId,
      )
    }
  })
  packageFiles
    .filter((file) => !baseline.fileReferences.some((reference) => reference.fileId === file.id))
    .forEach((file) => {
      const current = file.versions.find((item) => item.id === file.referencedVersionId)
      push('file-reference', file.name, '冻结时不存在该文件', current?.label ?? file.referencedVersionId)
    })

  const known = new Set(
    baseline.driftChanges.map((item) => driftSignature(item.kind, item.target, item.after)),
  )
  return detected.filter((item) => !known.has(driftSignature(item.kind, item.target, item.after)))
}

/**
 * 冻结对象变化后的核对链处置：
 * - 未完成路线的等待/活动步骤即时失效；路线已全部通过时最后一道审批关口重新打开；
 * - 已通过步骤保留，等待重新生成路线时沿用；
 * - 已核销许可转为待复核，额度不释放。
 * 返回追加到审计日志的文本说明。
 */
export function applyDriftEffects(
  packageItem: MaterialPackage,
  newDrifts: DriftChange[],
  license?: LicenseRecord,
): string[] {
  const auditDetails: string[] = []
  if (!newDrifts.length) return auditDetails

  newDrifts.forEach((drift) => {
    auditDetails.push(`冻结对象 ${drift.target} 由「${drift.before}」变为「${drift.after}」。`)
  })

  const route = packageItem.approvalRoute
  if (license && license.status === 'active') {
    license.status = 'pending-review'
    license.drifts.push(...newDrifts)
    packageItem.status = 'recheck'
    auditDetails.push('许可已转为待复核，预占/已核销额度不释放，等待人工复核。')
    return auditDetails
  }

  const unfinished = route.filter((step) => step.status === 'waiting' || step.status === 'active')
  unfinished.forEach((step) => {
    step.status = 'invalid'
  })
  if (!unfinished.length) {
    const gate = [...route].reverse().find((step) => step.status === 'approved')
    if (gate) {
      gate.status = 'invalid'
      auditDetails.push(`已通过步骤保留记录，审批关口「${gate.role}」需随路线重新生成后重签。`)
    }
  } else {
    auditDetails.push('未完成审批步骤即时失效，已通过步骤保留。')
  }

  if (packageItem.status === 'approved') packageItem.status = 'reviewing'
  return auditDetails
}

/** 扫描全部已冻结资料包，追加新增漂移并触发失效处置 */
export function reconcileDrifts(
  state: WorkspaceState,
  audit: (entry: { packageId?: string; action: string; target: string; operator: string; detail: string }) => void,
): void {
  state.packages.forEach((packageItem) => {
    const baseline = packageItem.frozenBaseline
    if (!baseline) return
    const license = getPackageLicense(packageItem.id, state)
    const fresh = detectDrift(baseline, packageItem, state.files)
    if (!fresh.length) return
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
}

/** 重新生成审批路线：沿用同序同角色的已通过步骤，其余步骤重新进入审批 */
export function regenerateRoute(previous: ApprovalStep[], level: ApprovalLevel): ApprovalStep[] {
  const fresh = createApprovalRoute(level)
  return fresh.map((step) => {
    const kept = previous.find(
      (old) => old.order === step.order && old.role === step.role && old.status === 'approved',
    )
    if (kept) {
      return { ...step, status: 'approved' as const, comment: kept.comment, decidedAt: kept.decidedAt }
    }
    return step
  })
}

export function isRouteFullyApproved(packageItem: MaterialPackage): boolean {
  return (
    packageItem.approvalRoute.length > 0 &&
    packageItem.approvalRoute.every((step) => step.status === 'approved')
  )
}

/** 让保留下来的路线中第一个未通过步骤进入活动状态 */
export function activateFirstPending(route: ApprovalStep[]): ApprovalStep[] {
  let firstPendingFound = false
  return route.map((step) => {
    if (step.status !== 'approved' && !firstPendingFound) {
      firstPendingFound = true
      return { ...step, status: 'active' }
    }
    return step
  })
}

/** 旧数据迁移：按当前引用版本回填冻结基线 */
export function backfillBaselines(state: WorkspaceState): void {
  state.packages.forEach((packageItem) => {
    if (packageItem.frozenBaseline) return
    if (!packageItem.approvalRoute.length) return
    const frozenAt =
      packageItem.approvalRoute.find((step) => step.decidedAt)?.decidedAt ?? packageItem.updatedAt
    packageItem.frozenBaseline = buildFrozenBaseline(
      packageItem,
      state.files,
      '旧数据回填',
      frozenAt,
    )
  })

  // 已许可的旧资料包补建许可记录与已核销预占，保持额度池口径一致
  state.packages.forEach((packageItem) => {
    const ruleId = packageItem.matchedRuleId ?? ''
    const hasReservation = (state.reservations ?? []).some(
      (item) => item.packageId === packageItem.id,
    )
    if (packageItem.status === 'licensed' && packageItem.quotaUsed > 0 && !hasReservation) {
      const reservationId = `reservation-backfill-${packageItem.id}`
      state.reservations.push({
        id: reservationId,
        packageId: packageItem.id,
        ruleId,
        amount: packageItem.quotaUsed,
        status: 'consumed',
        owner: packageItem.applicant,
        clientToken: `backfill-${packageItem.id}`,
        heldAt: packageItem.updatedAt,
        attempts: 1,
        lastAttemptAt: packageItem.updatedAt,
      })
      state.licenses.push({
        id: `license-backfill-${packageItem.id}`,
        packageId: packageItem.id,
        ruleId,
        reservationId,
        amount: packageItem.quotaUsed,
        status: 'active',
        licenseNo: `EC-OLD-${packageItem.code}`,
        issuedAt: packageItem.updatedAt,
        baseline:
          packageItem.frozenBaseline ??
          buildFrozenBaseline(packageItem, state.files, '旧数据回填'),
        drifts: [],
      })
    }
    // 已批准待额度确认的旧资料包，历史占用转在持预占
    if (packageItem.status === 'approved' && packageItem.quotaUsed > 0 && !hasReservation) {
      state.reservations.push({
        id: `reservation-backfill-${packageItem.id}`,
        packageId: packageItem.id,
        ruleId,
        amount: packageItem.quotaUsed,
        status: 'held',
        owner: packageItem.applicant,
        clientToken: `backfill-${packageItem.id}`,
        heldAt: packageItem.updatedAt,
        attempts: 1,
        lastAttemptAt: packageItem.updatedAt,
      })
    }
  })
}

export type MaterialCategory = 'drawing' | 'technical' | 'software'
export type PackageStatus =
  | 'draft'
  | 'validating'
  | 'reviewing'
  | 'returned'
  | 'approved'
  | 'quota-held'
  | 'licensed'
  | 'recheck'
  | 'locked'
export type ApprovalLevel = 'standard' | 'enhanced' | 'senior'
export type FindingLevel = 'high' | 'medium' | 'low'
export type FindingType =
  | 'missing-declaration'
  | 'escalation'
  | 'version-mismatch'
  | 'unclassified-page'
  | 'quota'
  | 'baseline-drift'

export interface PageReview {
  id: string
  page: number
  category: MaterialCategory
  controlled: boolean
  desensitized: boolean
  note: string
  reviewer: string
  reviewedAt?: string
}

export interface FileVersion {
  id: string
  label: string
  uploadedAt: string
  hash: string
  sizeKb: number
  pages: PageReview[]
  changeSummary: string
}

export interface MaterialFile {
  id: string
  packageId: string
  name: string
  kind: MaterialCategory
  activeVersionId: string
  referencedVersionId: string
  versions: FileVersion[]
}

export interface ApprovalStep {
  id: string
  order: number
  role: string
  assignee: string
  level: ApprovalLevel
  status: 'waiting' | 'active' | 'approved' | 'returned' | 'invalid'
  comment: string
  decidedAt?: string
}

/** 冻结对象的漂移类型：资料包版本、文件引用版本、声明 */
export type DriftKind = 'package-version' | 'file-reference' | 'declaration'

/** 冻结对象与当前数据不一致时的漂移记录 */
export interface DriftChange {
  id: string
  kind: DriftKind
  target: string
  before: string
  after: string
  detectedAt: string
}

/**
 * 提交审批时冻结的核对基线：资料包版本、文件引用版本和声明。
 * 冻结对象后续变化即产生漂移，未完成路线即时失效；许可则转为待复核。
 */
export interface FrozenBaseline {
  packageVersionId: string
  packageLabel: string
  frozenAt: string
  frozenBy: string
  declarations: string[]
  fileReferences: {
    fileId: string
    fileName: string
    versionId: string
    versionLabel: string
  }[]
  /** 触发重新生成路线的漂移（许可漂移记录在 license.drifts 中，不释放额度） */
  driftChanges: DriftChange[]
}

export type ReservationStatus = 'held' | 'consumed' | 'released'
export type LicenseStatus = 'active' | 'pending-review' | 'withdrawn'

/** 额度预占记录：确认额度时先预占，核销时幂等转核销，撤回后释放 */
export interface QuotaReservation {
  id: string
  packageId: string
  ruleId: string
  amount: number
  status: ReservationStatus
  owner: string
  /** 客户端幂等令牌：同令牌重试不会重复预占 */
  clientToken: string
  heldAt: string
  releasedAt?: string
  releaseReason?: string
  attempts: number
  lastAttemptAt: string
}

/** 许可记录：核销后生成；冻结对象再变化转为待复核且额度不释放，撤回后释放 */
export interface LicenseRecord {
  id: string
  packageId: string
  ruleId: string
  reservationId: string
  amount: number
  status: LicenseStatus
  licenseNo: string
  issuedAt: string
  withdrawnAt?: string
  withdrawReason?: string
  /** 核销时使用的冻结基线快照 */
  baseline: FrozenBaseline
  /** 许可后冻结对象发生的漂移 */
  drifts: DriftChange[]
}

export interface PackageVersion {
  id: string
  label: string
  createdAt: string
  createdBy: string
  summary: string
  snapshot: {
    title: string
    category: MaterialCategory
    destination: string
    endUse: string
    technologyTags: string[]
    personnelScopes: string[]
    declarations: string[]
    activeFileVersions: Record<string, string>
  }
}

export interface ReviewComment {
  id: string
  packageId: string
  author: string
  content: string
  createdAt: string
  round: number
}

export interface MaterialPackage {
  id: string
  code: string
  title: string
  category: MaterialCategory
  applicant: string
  recipient: string
  destination: string
  endUse: string
  technologyTags: string[]
  personnelScopes: string[]
  declarations: string[]
  status: PackageStatus
  matchedRuleId?: string
  approvalRoute: ApprovalStep[]
  /** 当前生效的冻结核对基线；提交审批时冻结，撤回/释放后清空 */
  frozenBaseline?: FrozenBaseline
  currentRound: number
  quotaUsed: number
  quotaLimit: number
  createdAt: string
  updatedAt: string
  versions: PackageVersion[]
}

export interface LicenseRule {
  id: string
  name: string
  categories: MaterialCategory[]
  destinations: string[]
  technologyTags: string[]
  personnelScopes: string[]
  requiredDeclarations: string[]
  approvalLevel: ApprovalLevel
  quotaLimit: number
  explanation: string
}

export interface ValidationFinding {
  id: string
  packageId: string
  type: FindingType
  level: FindingLevel
  message: string
  action: string
  ruleId?: string
}

export interface AuditEntry {
  id: string
  packageId?: string
  action: string
  target: string
  operator: string
  detail: string
  createdAt: string
}

export interface WorkspaceState {
  packages: MaterialPackage[]
  files: MaterialFile[]
  rules: LicenseRule[]
  findings: ValidationFinding[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  reservations: QuotaReservation[]
  licenses: LicenseRecord[]
}

export interface VersionDiff {
  id: string
  field: string
  before: string
  after: string
  kind: 'package' | 'file'
}

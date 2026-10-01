export type MaterialCategory = 'drawing' | 'technical' | 'software'
export type PackageStatus =
  | 'draft'
  | 'validating'
  | 'reviewing'
  | 'returned'
  | 'approved'
  | 'quota-reserved'
  | 'licensed'
  | 'license-review'
  | 'locked'
export type ApprovalLevel = 'standard' | 'enhanced' | 'senior'
export type FindingLevel = 'high' | 'medium' | 'low'
export type FindingType =
  | 'missing-declaration'
  | 'escalation'
  | 'version-mismatch'
  | 'unclassified-page'
  | 'quota'
  | 'freeze-drift'

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
  status: 'waiting' | 'active' | 'approved' | 'returned'
  comment: string
  decidedAt?: string
  /** 冻结对象变化后重建路线时，沿用上一轮已通过的步骤 */
  carriedOver?: boolean
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

/** 提交审批时冻结的核对基线：资料包版本、文件引用版本（含内容指纹）和声明 */
export interface FreezeBaseline {
  frozenAt: string
  frozenBy: string
  round: number
  packageVersionId: string
  packageVersionLabel: string
  fileReferences: Record<
    string,
    {
      name: string
      versionId: string
      label: string
      hash: string
      /** 引用版本逐页核对内容的指纹，页内分类/受控/脱敏/备注变化也算基线漂移 */
      contentFingerprint: string
    }
  >
  declarations: string[]
}

/** 冻结对象相对基线的变化项 */
export interface FreezeChange {
  kind: 'package-version' | 'file-reference' | 'file-content' | 'declaration'
  target: string
  before: string
  after: string
  at: string
}

export type ReservationStatus = 'held' | 'settled' | 'released'

/** 许可额度预占记录：核销前先预占，核销失败保留、重试不重复占用 */
export interface QuotaReservation {
  id: string
  packageId: string
  ruleId: string
  amount: number
  /** 预占窗口标识，同一规则池下只允许一个窗口持有预占 */
  holder: string
  holderLabel: string
  status: ReservationStatus
  attempts: number
  lastError: string
  createdAt: string
  heldAt: string
  settledAt?: string
  releasedAt?: string
  releaseReason?: string
}

export type LicenseStatus = 'active' | 'pending-review' | 'revoked'

/** 核销后生成的许可记录，独立保存冻结基线，供核销后复核与撤回追溯 */
export interface LicenseRecord {
  id: string
  packageId: string
  packageCode: string
  ruleId: string
  amount: number
  quotaReservationId: string
  baseline: FreezeBaseline
  status: LicenseStatus
  createdAt: string
  reviewReason: string
  reviewChangedAt?: string
  changes: FreezeChange[]
  revokedAt?: string
  revokeReason?: string
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
  currentRound: number
  quotaUsed: number
  quotaLimit: number
  createdAt: string
  updatedAt: string
  versions: PackageVersion[]
  /** 当前审批轮次冻结的核对基线，核销后保留用于许可复核 */
  freezeBaseline?: FreezeBaseline
  /** 持有的额度预占 */
  reservationId?: string
  /** 冻结对象变化，未完成审批路线已即时失效，等待重新发起 */
  routeInvalidated?: boolean
  routeInvalidatedChanges?: FreezeChange[]
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

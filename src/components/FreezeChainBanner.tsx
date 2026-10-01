import { Alert } from 'antd'
import type { MaterialPackage } from '@/types/domain'

interface Props {
  packageItem: MaterialPackage
  holderLabel?: string
}

function changeText(packageItem: MaterialPackage): string {
  return (packageItem.routeInvalidatedChanges ?? [])
    .map((change) => `${change.target}：${change.before} → ${change.after}`)
    .join('；')
}

/** 展示冻结基线、漂移失效与许可待复核状态的核对链横幅 */
export function FreezeChainBanner({ packageItem, holderLabel }: Props) {
  if (packageItem.status === 'license-review') {
    return (
      <Alert
        type="error"
        showIcon
        message="许可待人工复核：核销后冻结对象发生变化"
        description={`${changeText(packageItem) || '冻结基线与当前资料不一致'}。许可额度保持占用不释放，确认无误后重新核验，或人工撤回并释放额度。`}
        style={{ marginBottom: 16 }}
      />
    )
  }
  if (packageItem.routeInvalidated && packageItem.status !== 'licensed') {
    return (
      <Alert
        type="warning"
        showIcon
        message="冻结对象已变化，当前审批路线即时失效"
        description={`${changeText(packageItem)}。已通过步骤保留，请按新基线重新发起路线并补签未完成步骤。`}
        style={{ marginBottom: 16 }}
      />
    )
  }
  const baseline = packageItem.freezeBaseline
  if (baseline && packageItem.status !== 'draft' && packageItem.status !== 'returned') {
    const reserved =
      packageItem.status === 'quota-reserved' && holderLabel
        ? `；额度预占人：${holderLabel}`
        : ''
    return (
      <Alert
        type="info"
        showIcon
        message={`核对链已冻结：资料包版本 ${baseline.packageVersionLabel} · ${Object.keys(baseline.fileReferences).length} 个文件引用版本 · ${baseline.declarations.length} 项声明（第 ${baseline.round} 轮，${baseline.frozenBy}）${reserved}`}
        style={{ marginBottom: 16 }}
      />
    )
  }
  return null
}

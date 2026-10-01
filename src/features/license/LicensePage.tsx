import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Descriptions,
  Input,
  InputNumber,
  Modal,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { SafetyCertificateOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import {
  useConfirmLicenseMutation,
  useGetWorkspaceQuery,
  useReserveQuotaMutation,
  useValidatePackageMutation,
  useWithdrawLicenseMutation,
} from '@/app/api'
import type { LicenseRecord, LicenseRule, QuotaReservation } from '@/types/domain'
import { approvalLevelLabels, findApplicableRule } from '@/services/rules'
import { getPackageLicense, getRulePool } from '@/services/reconciliation'

export function LicensePage() {
  const [searchParams] = useSearchParams()
  const { data, isLoading } = useGetWorkspaceQuery()
  const [validatePackage] = useValidatePackageMutation()
  const [reserveQuota, reserveState] = useReserveQuotaMutation()
  const [confirmLicense, confirmState] = useConfirmLicenseMutation()
  const [withdrawLicense, withdrawState] = useWithdrawLicenseMutation()
  const [selectedId, setSelectedId] = useState(searchParams.get('package') ?? '')
  const [amount, setAmount] = useState(5)
  const [withdrawOpen, setWithdrawOpen] = useState(false)
  const [withdrawReason, setWithdrawReason] = useState('')
  // 同一笔预占流程复用幂等令牌：预占成功后重试核销不多占；预占失败重新取令牌
  const reserveToken = useRef<string>('')

  useEffect(() => {
    if (!selectedId && data?.packages[0]) setSelectedId(data.packages[0].id)
  }, [data, selectedId])

  const selected = useMemo(
    () => data?.packages.find((item) => item.id === selectedId),
    [data, selectedId],
  )
  const applicableRule = selected && data ? findApplicableRule(selected, data.rules) : undefined
  const packageFindings = data?.findings.filter((item) => item.packageId === selectedId) ?? []
  const hasHighFindings = packageFindings.some((item) => item.level === 'high')
  const pool = data && selected ? getRulePool(selected.matchedRuleId ?? '', data) : undefined
  const held: QuotaReservation | undefined =
    data && selected ? data.reservations.find((item) => item.packageId === selected.id && item.status === 'held') : undefined
  const license: LicenseRecord | undefined =
    data && selected ? getPackageLicense(selected.id, data) : undefined

  if (isLoading || !data) return <div className="panel">正在加载许可规则...</div>

  const ruleColumns: TableColumnsType<LicenseRule> = [
    { title: '规则名称', dataIndex: 'name', minWidth: 240 },
    {
      title: '国家或地区',
      dataIndex: 'destinations',
      width: 135,
      render: (values: string[]) => values.join('、'),
    },
    {
      title: '技术标签',
      dataIndex: 'technologyTags',
      width: 220,
      render: (values: string[]) => values.join('、') || '通用',
    },
    {
      title: '审批等级',
      dataIndex: 'approvalLevel',
      width: 110,
      render: (value: LicenseRule['approvalLevel']) => approvalLevelLabels[value],
    },
    {
      title: '规则额度',
      dataIndex: 'quotaLimit',
      width: 100,
    },
  ]

  async function refreshValidation() {
    if (!selected) return
    await validatePackage({ packageId: selected.id }).unwrap()
    message.success('规则匹配、冻结基线漂移和缺失声明已重新校验')
  }

  function readError(error: unknown): { error?: string; remaining?: number; holders?: { packageCode: string; owner: string; amount: number }[] } {
    return typeof error === 'object' && error && 'data' in error
      ? (error.data as { error?: string; remaining?: number; holders?: { packageCode: string; owner: string; amount: number }[] })
      : {}
  }

  async function reserve() {
    if (!selected) return
    if (!reserveToken.current) reserveToken.current = crypto.randomUUID()
    try {
      await reserveQuota({
        packageId: selected.id,
        amount,
        clientToken: reserveToken.current,
        owner: '当前用户',
      }).unwrap()
      message.success(`已预占 ${amount} 个许可额度，请继续完成核销`)
    } catch (error) {
      reserveToken.current = ''
      const detail = readError(error)
      const holderText = detail.holders?.length
        ? `；当前预占人：${detail.holders
            .map((holder) => `${holder.packageCode}（${holder.owner}）占 ${holder.amount}`)
            .join('、')}`
        : ''
      message.error({
        content: `${detail.error ?? '预占失败'}${
          typeof detail.remaining === 'number' ? `；剩余额度 ${detail.remaining}` : ''
        }${holderText}`,
        duration: 6,
      })
    }
  }

  async function confirm() {
    if (!selected) return
    try {
      await confirmLicense({ packageId: selected.id }).unwrap()
      reserveToken.current = ''
      message.success('许可已核销，许可记录已生成')
    } catch (error) {
      const detail = readError(error)
      message.error({
        content: `${detail.error ?? '核销失败'}；预占已保留，可直接重试，重试不会重复占用额度。`,
        duration: 6,
      })
    }
  }

  async function confirmWithdraw() {
    if (!selected) return
    try {
      await withdrawLicense({ packageId: selected.id, reason: withdrawReason || '人工撤回' }).unwrap()
      message.success('许可已撤回，冻结额度已释放')
      setWithdrawOpen(false)
      setWithdrawReason('')
    } catch (error) {
      message.error(readError(error).error ?? '撤回失败')
    }
  }

  const status = selected?.status
  const chainStepStatus: ('finish' | 'process' | 'wait' | 'error')[] = [
    status === 'reviewing'
      ? 'process'
      : ['approved', 'quota-held', 'licensed', 'recheck'].includes(status ?? '')
        ? 'finish'
        : 'wait',
    status === 'quota-held'
      ? 'process'
      : ['licensed', 'recheck'].includes(status ?? '')
        ? 'finish'
        : 'wait',
    ['licensed', 'recheck'].includes(status ?? '') ? 'finish' : 'wait',
  ]

  return (
    <div>
      <PageHeader
        title="许可与额度"
        description="审批放行后先预占额度（并发仅一笔成功），核销生成许可记录；冻结对象再变化转待复核且不释放额度，人工撤回后释放。"
        actions={
          selected ? (
            <Button loading={false} onClick={refreshValidation}>
              重新校验
            </Button>
          ) : null
        }
      />

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>选择资料包</h3>
            <Tag>{data.rules.length} 条规则</Tag>
          </div>
          <Select
            value={selectedId || undefined}
            style={{ width: '100%' }}
            onChange={(value) => {
              setSelectedId(value)
              reserveToken.current = ''
            }}
            options={data.packages.map((item) => ({
              value: item.id,
              label: `${item.code} · ${item.title} · ${item.destination}`,
            }))}
          />
          {selected ? (
            <Descriptions column={1} bordered size="small" style={{ marginTop: 16 }}>
              <Descriptions.Item label="收件方">{selected.recipient}</Descriptions.Item>
              <Descriptions.Item label="最终用途">{selected.endUse}</Descriptions.Item>
              <Descriptions.Item label="技术参数">
                {selected.technologyTags.join('、')}
              </Descriptions.Item>
              <Descriptions.Item label="人员范围">
                {selected.personnelScopes.join('、') || '无特别范围'}
              </Descriptions.Item>
              <Descriptions.Item label="核对链状态">
                {selected.status === 'approved'
                  ? '审批已放行，等待预占'
                  : selected.status === 'quota-held'
                    ? '额度已预占，等待核销'
                    : selected.status === 'licensed'
                      ? '许可已核销'
                      : selected.status === 'recheck'
                        ? '冻结对象变化，许可待人工复核'
                        : selected.status === 'reviewing'
                          ? '审批中'
                          : selected.status === 'returned'
                            ? '已退回'
                            : '草稿'}
              </Descriptions.Item>
              <Descriptions.Item label="冻结基线">
                {selected.frozenBaseline
                  ? `${selected.frozenBaseline.packageLabel} · ${selected.frozenBaseline.fileReferences.length} 个文件引用 · ${selected.frozenBaseline.declarations.length} 项声明`
                  : '未冻结（提交审批时冻结）'}
              </Descriptions.Item>
            </Descriptions>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>核对链进度</h3>
            <SafetyCertificateOutlined />
          </div>
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <div style={{ display: 'flex', gap: 12 }}>
              {[
                { title: '审批放行', desc: '冻结资料包/文件引用/声明' },
                { title: '额度预占', desc: '并发仅一笔成功' },
                { title: '许可核销', desc: '生成许可记录' },
              ].map((item, index) => (
                <div
                  key={item.title}
                  className={`version-box`}
                  style={{
                    flex: 1,
                    textAlign: 'center',
                    borderColor: chainStepStatus[index] === 'error' ? '#ff4d4f' : undefined,
                  }}
                >
                  <Tag
                    color={
                      chainStepStatus[index] === 'finish'
                        ? 'success'
                        : chainStepStatus[index] === 'process'
                          ? 'processing'
                          : 'default'
                    }
                  >
                    {index + 1}. {item.title}
                  </Tag>
                  <div className="muted" style={{ marginTop: 6 }}>
                    {item.desc}
                  </div>
                </div>
              ))}
            </div>
            {applicableRule ? (
              <Alert
                type="info"
                showIcon
                message={applicableRule.name}
                description={applicableRule.explanation}
              />
            ) : (
              <Alert type="error" showIcon message="没有匹配到规则，必须执行人工判定。" />
            )}
          </Space>
        </section>
      </div>

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>缺失声明与基线漂移</h3>
            <Tag color={hasHighFindings ? 'error' : 'success'}>{packageFindings.length} 项</Tag>
          </div>
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            {packageFindings.map((finding) => (
              <Alert
                key={finding.id}
                type={finding.level === 'high' ? 'error' : finding.level === 'medium' ? 'warning' : 'info'}
                showIcon
                message={finding.message}
                description={finding.action}
              />
            ))}
            {!packageFindings.length ? (
              <Alert type="success" showIcon message="当前资料包没有许可核对缺口。" />
            ) : null}
          </Space>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>额度预占与许可核销</h3>
            <SafetyCertificateOutlined />
          </div>
          {selected && pool ? (
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <div>
                <Progress
                  percent={Math.round(((pool.consumed + pool.held) / pool.limit) * 100)}
                  status={pool.remaining <= 0 ? 'exception' : 'active'}
                />
                <div>
                  规则池上限 {pool.limit}，已核销 {pool.consumed}，在持预占 {pool.held}，
                  <strong> 剩余可预占 {pool.remaining}</strong>
                </div>
              </div>

              {pool.holderDescriptions.length ? (
                <Alert
                  type="warning"
                  showIcon
                  message="当前在持预占"
                  description={pool.holderDescriptions.map((holder) => (
                    <div key={holder.packageId}>
                      {holder.packageCode} · {holder.owner} · 预占 {holder.amount}
                    </div>
                  ))}
                />
              ) : null}

              {held ? (
                <Alert
                  type="info"
                  showIcon
                  message={`已有 ${held.owner} 的在持预占 ${held.amount}（${new Date(held.heldAt).toLocaleString('zh-CN')}）`}
                  description="预占在核销失败时保留；可直接重试核销，重复重试不会多占。"
                />
              ) : null}

              {license ? (
                <Alert
                  type={license.status === 'active' ? 'success' : license.status === 'pending-review' ? 'error' : 'info'}
                  showIcon
                  message={`许可记录 ${license.licenseNo} · ${license.status === 'active' ? '有效' : license.status === 'pending-review' ? '待复核' : '已撤回'}`}
                  description={
                    <Space direction="vertical" size={4}>
                      <span>
                        核销额度 {license.amount}，签发于 {new Date(license.issuedAt).toLocaleString('zh-CN')}
                      </span>
                      {license.drifts.length ? (
                        <span>
                          冻结对象再变化 {license.drifts.length} 项，许可已转待复核，
                          <strong>额度不释放</strong>，可人工复核后撤回释放。
                        </span>
                      ) : null}
                      {license.withdrawReason ? <span>撤回原因：{license.withdrawReason}</span> : null}
                    </Space>
                  }
                />
              ) : null}

              {!license ? (
                <>
                  <InputNumber
                    min={1}
                    max={Math.max(1, pool.remaining)}
                    value={amount}
                    disabled={selected.status !== 'approved'}
                    onChange={(value) => setAmount(value ?? 1)}
                    addonAfter="额度单位"
                    style={{ width: '100%' }}
                  />
                  <Button
                    type="primary"
                    block
                    disabled={
                      selected.status !== 'approved' ||
                      hasHighFindings ||
                      amount > pool.remaining ||
                      pool.remaining <= 0
                    }
                    loading={reserveState.isLoading}
                    onClick={reserve}
                  >
                    确认额度并预占
                  </Button>
                  <Button
                    block
                    disabled={selected.status !== 'quota-held'}
                    loading={confirmState.isLoading}
                    onClick={confirm}
                  >
                    核销预占并生成许可
                  </Button>
                </>
              ) : license.status === 'pending-review' ? (
                <Button danger block loading={withdrawState.isLoading} onClick={() => setWithdrawOpen(true)}>
                  人工撤回并释放额度
                </Button>
              ) : null}

              {selected.status !== 'approved' && selected.status !== 'quota-held' && !license ? (
                <Alert type="warning" showIcon message="只有全部审批步骤放行后才允许预占额度。" />
              ) : null}
              {hasHighFindings ? (
                <Alert type="error" showIcon message="存在高风险核对项或冻结基线漂移，系统拒绝预占/核销。" />
              ) : null}
            </Space>
          ) : null}
        </section>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h3>规则清单与占用口径</h3>
          <span className="muted">同一规则的额度为共享池：在持预占与未撤回许可共同占用，重复重试不会多占</span>
        </div>
        <Table
          rowKey="id"
          columns={[
            ...ruleColumns,
            {
              title: '已核销',
              width: 90,
              render: (_, rule) =>
                data.licenses
                  .filter((item) => item.ruleId === rule.id && item.status !== 'withdrawn')
                  .reduce((sum, item) => sum + item.amount, 0),
            },
            {
              title: '在持预占',
              width: 90,
              render: (_, rule) =>
                data.reservations
                  .filter((item) => item.ruleId === rule.id && item.status === 'held')
                  .reduce((sum, item) => sum + item.amount, 0),
            },
          ]}
          dataSource={data.rules}
          pagination={false}
        />
      </section>

      <Modal
        title="人工撤回待复核许可"
        open={withdrawOpen}
        onCancel={() => setWithdrawOpen(false)}
        onOk={confirmWithdraw}
        confirmLoading={withdrawState.isLoading}
        okText="确认撤回并释放额度"
        okButtonProps={{ danger: true }}
        cancelText="取消"
      >
        <Alert
          type="warning"
          showIcon
          message={`撤回后释放预占/核销额度 ${license?.amount ?? 0}，许可记录标记为已撤回，冻结基线清空，需重新走核对链。`}
          style={{ marginBottom: 14 }}
        />
        <Input.TextArea
          rows={4}
          value={withdrawReason}
          onChange={(event) => setWithdrawReason(event.target.value)}
          placeholder="说明撤回原因（如冻结对象变更后复核不通过）"
        />
      </Modal>
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
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
  clientId,
  clientLabel,
  findActiveLicense,
  findReservation,
  ruleQuotaPool,
} from '@/services/chain'
import {
  useGetWorkspaceQuery,
  useReconfirmLicenseMutation,
  useReserveQuotaMutation,
  useRevokeLicenseMutation,
  useSettleQuotaMutation,
  useValidatePackageMutation,
} from '@/app/api'
import type { LicenseRecord, LicenseRule, QuotaReservation } from '@/types/domain'
import { approvalLevelLabels, findApplicableRule } from '@/services/rules'

interface MutationError {
  data?: {
    error?: string
    code?: string
    holder?: string
    holderLabel?: string
    remaining?: number
    amount?: number
  }
}

export function LicensePage() {
  const [searchParams] = useSearchParams()
  const { data, isLoading, refetch } = useGetWorkspaceQuery()
  const [validatePackage] = useValidatePackageMutation()
  const [reserveQuota, reserveState] = useReserveQuotaMutation()
  const [settleQuota, settleState] = useSettleQuotaMutation()
  const [revokeLicense, revokeState] = useRevokeLicenseMutation()
  const [reconfirmLicense, reconfirmState] = useReconfirmLicenseMutation()
  const [selectedId, setSelectedId] = useState(searchParams.get('package') ?? '')
  const [amount, setAmount] = useState(5)
  const [simulateFailure, setSimulateFailure] = useState(false)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [revokeReason, setRevokeReason] = useState('')
  const [conflictNote, setConflictNote] = useState('')

  useEffect(() => {
    if (!selectedId && data?.packages[0]) setSelectedId(data.packages[0].id)
  }, [data, selectedId])

  const selected = useMemo(
    () => data?.packages.find((item) => item.id === selectedId),
    [data, selectedId],
  )
  const applicableRule = selected && data ? findApplicableRule(selected, data.rules) : undefined
  const currentRule = data?.rules.find((item) => item.id === selected?.matchedRuleId)
  const packageFindings = data?.findings.filter((item) => item.packageId === selectedId) ?? []
  const blockingHigh = packageFindings.filter(
    (item) => item.level === 'high' && item.type !== 'freeze-drift' && item.type !== 'quota',
  )
  const reservation = data && selected ? findReservation(data, selected.id) : undefined
  const license = data && selected ? findActiveLicense(data, selected.id) : undefined
  const pool = data && currentRule ? ruleQuotaPool(data, currentRule.id) : undefined
  const remaining = pool?.remaining ?? 0
  const settledReservation =
    data && selected
      ? data.reservations.find(
          (item) => item.packageId === selected.id && item.status === 'settled',
        )
      : undefined

  if (isLoading || !data) return <div className="panel">正在加载许可规则...</div>

  const ruleColumns: TableColumnsType<LicenseRule> = [
    { title: '规则名称', dataIndex: 'name', minWidth: 220 },
    {
      title: '国家或地区',
      dataIndex: 'destinations',
      width: 120,
      render: (values: string[]) => values.join('、'),
    },
    {
      title: '审批等级',
      dataIndex: 'approvalLevel',
      width: 100,
      render: (value: LicenseRule['approvalLevel']) => approvalLevelLabels[value],
    },
    {
      title: '规则额度',
      dataIndex: 'quotaLimit',
      width: 90,
    },
    {
      title: '已核销',
      width: 90,
      render: (_, rule) => ruleQuotaPool(data, rule.id).used,
    },
    {
      title: '预占中',
      width: 90,
      render: (_, rule) => ruleQuotaPool(data, rule.id).held,
    },
    {
      title: '剩余',
      width: 90,
      render: (_, rule) => (
        <Tag color={ruleQuotaPool(data, rule.id).remaining <= 10 ? 'error' : 'success'}>
          {ruleQuotaPool(data, rule.id).remaining}
        </Tag>
      ),
    },
  ]

  const licenseColumns: TableColumnsType<LicenseRecord> = [
    {
      title: '资料包',
      dataIndex: 'packageCode',
      width: 130,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: LicenseRecord['status']) =>
        value === 'active' ? (
          <Tag color="green">有效</Tag>
        ) : value === 'pending-review' ? (
          <Tag color="purple">待复核</Tag>
        ) : (
          <Tag color="error">已撤回</Tag>
        ),
    },
    { title: '核销额度', dataIndex: 'amount', width: 90 },
    {
      title: '冻结基线',
      width: 220,
      render: (_, record) =>
        `${record.baseline.packageVersionLabel} · ${Object.keys(record.baseline.fileReferences).length} 文件 · ${record.baseline.declarations.length} 声明`,
    },
    {
      title: '核销/撤回时间',
      width: 170,
      render: (_, record) =>
        new Date(record.revokedAt ?? record.createdAt).toLocaleString('zh-CN'),
    },
    {
      title: '复核原因',
      dataIndex: 'reviewReason',
      render: (value: string) => value || <span className="muted">—</span>,
    },
  ]

  const reservationColumns: TableColumnsType<QuotaReservation> = [
    {
      title: '资料包',
      width: 130,
      render: (_, record) => data.packages.find((item) => item.id === record.packageId)?.code,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: QuotaReservation['status']) =>
        value === 'held' ? (
          <Tag color="orange">预占中</Tag>
        ) : value === 'settled' ? (
          <Tag color="green">已核销</Tag>
        ) : (
          <Tag color="default">已释放</Tag>
        ),
    },
    { title: '额度', dataIndex: 'amount', width: 80 },
    { title: '预占窗口', dataIndex: 'holderLabel', width: 110 },
    { title: '核销尝试', dataIndex: 'attempts', width: 90 },
    {
      title: '最近错误',
      dataIndex: 'lastError',
      render: (value: string) => value || <span className="muted">—</span>,
    },
  ]

  function readError(error: unknown): MutationError['data'] {
    const detail =
      typeof error === 'object' && error && 'data' in error
        ? ((error as MutationError).data ?? undefined)
        : undefined
    if (detail?.code === 'quota-occupied') {
      setConflictNote(
        `预占人：${detail.holderLabel}，对方持有 ${detail.amount}，规则池剩余 ${detail.remaining}。当前窗口已读回最新额度，可稍后重试或选择其他资料包。`,
      )
    }
    return detail
  }

  async function refreshValidation() {
    if (!selected) return
    await validatePackage({ packageId: selected.id }).unwrap()
    message.success('规则匹配、冻结基线和额度池已重新校验')
  }

  async function reserve() {
    if (!selected) return
    setConflictNote('')
    try {
      await reserveQuota({ packageId: selected.id, amount, clientId, clientLabel }).unwrap()
      message.success(`已预占 ${amount} 个许可额度，等待核销`)
    } catch (error) {
      const detail = readError(error)
      message.error(detail?.error ?? '额度预占失败')
    }
  }

  async function settle() {
    if (!selected) return
    setConflictNote('')
    try {
      await settleQuota({
        packageId: selected.id,
        simulateFailure,
        clientId,
        clientLabel,
      }).unwrap()
      message.success(`预占 ${reservation?.amount ?? amount} 已核销，许可记录已生成`)
      setSimulateFailure(false)
    } catch (error) {
      const detail = readError(error)
      message.error(detail?.error ?? '核销失败')
    }
  }

  async function confirmRevoke() {
    if (!selected) return
    await revokeLicense({ packageId: selected.id, reason: revokeReason || '人工撤回' }).unwrap()
    message.success('许可已撤回，额度已释放，可重新发起审批')
    setRevokeOpen(false)
    setRevokeReason('')
  }

  async function reconfirm() {
    if (!selected) return
    await reconfirmLicense({ packageId: selected.id }).unwrap()
    message.success('复核通过，已按当前对象重新冻结基线')
  }

  const allApproved =
    selected !== undefined &&
    selected.approvalRoute.length > 0 &&
    selected.approvalRoute.every((step) => step.status === 'approved')
  const canReserve =
    selected !== undefined &&
    (selected.status === 'approved' ||
      (selected.status === 'reviewing' && allApproved && !selected.routeInvalidated)) &&
    blockingHigh.length === 0 &&
    !reservation &&
    !license &&
    remaining > 0
  const reservedBySelf = reservation?.holder === clientId
  const usedPercent = pool && pool.limit ? Math.round(((pool.used + pool.held) / pool.limit) * 100) : 0

  return (
    <div>
      <PageHeader
        title="许可与额度"
        description="审批放行先冻结核对基线，额度先预占后核销；核销失败保留预占可幂等重试，撤回释放额度。"
        actions={
          <Space>
            <Tag color="blue">本窗口 {clientLabel}</Tag>
            {selected ? (
              <Button loading={reserveState.isLoading || settleState.isLoading} onClick={refreshValidation}>
                重新校验
              </Button>
            ) : null}
          </Space>
        }
      />

      {conflictNote ? (
        <Alert
          type="warning"
          showIcon
          message="并发预占冲突：只有一个窗口成功"
          description={
            <Space>
              <span>{conflictNote}</span>
              <Button size="small" onClick={() => { void refetch() }}>
                读回最新额度
              </Button>
            </Space>
          }
          style={{ marginBottom: 16 }}
        />
      ) : null}

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
              setConflictNote('')
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
              <Descriptions.Item label="审批状态">
                {selected.status === 'approved'
                  ? '已批准，待预占额度'
                  : selected.status === 'quota-reserved'
                    ? '额度已预占，待核销'
                    : selected.status === 'licensed'
                      ? '已核销生成许可'
                      : selected.status === 'license-review'
                        ? '许可待复核'
                        : selected.status === 'reviewing'
                          ? selected.routeInvalidated
                            ? '冻结变化，路线失效待重提'
                            : '审批中'
                          : selected.status === 'returned'
                            ? '已退回'
                            : '草稿'}
              </Descriptions.Item>
              <Descriptions.Item label="冻结基线">
                {selected.freezeBaseline
                  ? `${selected.freezeBaseline.packageVersionLabel} · 第 ${selected.freezeBaseline.round} 轮`
                  : '未冻结'}
              </Descriptions.Item>
            </Descriptions>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>规则匹配解释</h3>
            <Tag color={applicableRule ? 'success' : 'error'}>
              {applicableRule ? '存在适用规则' : '无适用规则'}
            </Tag>
          </div>
          {applicableRule ? (
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              <Alert
                type="info"
                showIcon
                message={applicableRule.name}
                description={applicableRule.explanation}
              />
              <div>
                <strong>必要声明核对</strong>
                <div style={{ marginTop: 8 }}>
                  {applicableRule.requiredDeclarations.map((declaration) => (
                    <Tag
                      key={declaration}
                      color={selected?.declarations.includes(declaration) ? 'success' : 'error'}
                    >
                      {declaration}
                    </Tag>
                  ))}
                </div>
              </div>
            </Space>
          ) : (
            <Alert type="error" showIcon message="没有匹配到规则，必须执行人工判定。" />
          )}
        </section>
      </div>

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>缺失声明与升级要求</h3>
            <Tag color={packageFindings.some((item) => item.level === 'high') ? 'error' : 'success'}>
              {packageFindings.length} 项
            </Tag>
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
            <h3>额度预占与核销</h3>
            <SafetyCertificateOutlined />
          </div>
          {selected && pool ? (
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              <Progress
                percent={usedPercent}
                status={pool.remaining <= 0 ? 'exception' : 'active'}
              />
              <div>
                规则池 {currentRule?.name}：上限 {pool.limit}，已核销 {pool.used}，预占中{' '}
                {pool.held}，<strong>可预占剩余 {pool.remaining}</strong>
              </div>

              {reservation ? (
                <Alert
                  type={reservedBySelf ? 'warning' : 'error'}
                  showIcon
                  message={
                    reservedBySelf
                      ? `本窗口持有预占 ${reservation.amount}（已尝试核销 ${reservation.attempts} 次）`
                      : `预占由其他窗口持有：${reservation.holderLabel}`
                  }
                  description={
                    reservation.lastError ||
                    (reservedBySelf
                      ? '预占在核销失败后保留；重复点击核销不会多占额度。'
                      : '当前窗口不能核销该笔预占，可读回剩余额度后稍后再试。')
                  }
                />
              ) : null}

              <InputNumber
                min={1}
                max={Math.max(1, pool.remaining)}
                value={amount}
                onChange={(value) => setAmount(value ?? 1)}
                addonAfter="额度单位"
                style={{ width: '100%' }}
                disabled={Boolean(reservation) || Boolean(license)}
              />

              <Button
                block
                disabled={!canReserve}
                loading={reserveState.isLoading}
                onClick={reserve}
              >
                第一步：预占额度
              </Button>
              <Button
                type="primary"
                block
                disabled={!reservation || !reservedBySelf || Boolean(license)}
                loading={settleState.isLoading}
                onClick={settle}
              >
                第二步：核销预占并生成许可
              </Button>
              <Checkbox
                checked={simulateFailure}
                onChange={(event) => setSimulateFailure(event.target.checked)}
                disabled={!reservation || Boolean(license)}
              >
                模拟核销失败（验证预占保留、重试不多占）
              </Checkbox>

              {license ? (
                <Space>
                  <Tag color={license.status === 'active' ? 'green' : 'purple'}>
                    {license.status === 'active' ? '许可有效' : '许可待复核'}
                  </Tag>
                  {license.status === 'pending-review' ? (
                    <>
                      <Button onClick={reconfirm} loading={reconfirmState.isLoading}>
                        人工复核通过
                      </Button>
                      <Button danger onClick={() => setRevokeOpen(true)}>
                        撤回并释放额度
                      </Button>
                    </>
                  ) : (
                    <Button danger onClick={() => setRevokeOpen(true)}>
                      人工撤回许可
                    </Button>
                  )}
                </Space>
              ) : null}

              {selected.routeInvalidated && selected.status !== 'license-review' ? (
                <Alert
                  type="warning"
                  showIcon
                  message="冻结对象已变化，审批路线失效，核销已阻断，请回审批页重新发起并补签。"
                />
              ) : null}
              {blockingHigh.length ? (
                <Alert type="error" showIcon message="存在高风险核对项，系统拒绝预占额度。" />
              ) : null}
              {!allApproved && selected.status !== 'licensed' && selected.status !== 'license-review' && !reservation ? (
                <Alert type="info" showIcon message="全部审批步骤通过后才允许预占额度。" />
              ) : null}
              {settledReservation && !license ? (
                <Alert type="success" showIcon message="预占已核销，许可记录见下方清单。" />
              ) : null}
            </Space>
          ) : null}
        </section>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h3>许可记录</h3>
          <span className="muted">核销后生成，独立保存冻结基线；冻结对象再变化转为待复核且不释放额度</span>
        </div>
        <Table
          rowKey="id"
          columns={licenseColumns}
          dataSource={[...data.licenses].sort((a, b) => b.createdAt.localeCompare(a.createdAt))}
          pagination={false}
        />
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>额度预占记录</h3>
          <span className="muted">同一规则池同时只允许一个窗口持有预占</span>
        </div>
        <Table
          rowKey="id"
          columns={reservationColumns}
          dataSource={[...data.reservations].sort((a, b) => b.heldAt.localeCompare(a.heldAt))}
          pagination={false}
        />
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>规则额度池</h3>
          <span className="muted">额度按规则池共享：其他资料包的核销与预占会实时占用剩余额度</span>
        </div>
        <Table rowKey="id" columns={ruleColumns} dataSource={data.rules} pagination={false} />
      </section>

      <Modal
        title="人工撤回许可"
        open={revokeOpen}
        onCancel={() => setRevokeOpen(false)}
        onOk={confirmRevoke}
        confirmLoading={revokeState.isLoading}
        okText="确认撤回并释放额度"
        okButtonProps={{ danger: true }}
        cancelText="取消"
      >
        <Alert
          type="warning"
          showIcon
          message="撤回后许可失效，占用额度立即释放，资料包回到退回状态，需按当前冻结对象重新发起审批。"
          style={{ marginBottom: 14 }}
        />
        <Input.TextArea
          rows={3}
          value={revokeReason}
          onChange={(event) => setRevokeReason(event.target.value)}
          placeholder="说明撤回原因（将写入审计与许可记录）"
        />
      </Modal>
    </div>
  )
}

import { Alert, Button, Progress, Space, Table, Tag } from 'antd'
import type { TableColumnsType } from 'antd'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { StatusTag } from '@/components/StatusTag'
import { useGetWorkspaceQuery } from '@/app/api'
import type { MaterialPackage, ValidationFinding } from '@/types/domain'
import { categoryLabels } from '@/services/mockData'

export function DashboardPage() {
  const navigate = useNavigate()
  const { data, isLoading } = useGetWorkspaceQuery()

  if (isLoading || !data) return <div className="panel">正在加载本地工作区...</div>

  const highFindings = data.findings.filter((item) => item.level === 'high')
  const activePackages = data.packages.filter((item) =>
    ['validating', 'reviewing', 'returned', 'approved', 'quota-reserved', 'license-review'].includes(item.status),
  )
  const heldReservations = data.reservations.filter((item) => item.status === 'held')
  const pendingReviewLicenses = data.licenses.filter((item) => item.status === 'pending-review')
  const invalidatedRoutes = data.packages.filter((item) => item.routeInvalidated)
  const reviewedPages = data.files.reduce(
    (total, file) =>
      total +
      (file.versions.find((version) => version.id === file.activeVersionId)?.pages.filter(
        (page) => page.reviewedAt,
      ).length ?? 0),
    0,
  )
  const totalPages = data.files.reduce(
    (total, file) =>
      total +
      (file.versions.find((version) => version.id === file.activeVersionId)?.pages.length ?? 0),
    0,
  )

  const findingColumns: TableColumnsType<ValidationFinding> = [
    {
      title: '等级',
      dataIndex: 'level',
      width: 80,
      render: (level: ValidationFinding['level']) => (
        <Tag color={level === 'high' ? 'error' : level === 'medium' ? 'warning' : 'blue'}>
          {level === 'high' ? '高' : level === 'medium' ? '中' : '低'}
        </Tag>
      ),
    },
    {
      title: '核对结论',
      dataIndex: 'message',
      render: (_, record) => (
        <div>
          <div className="finding-message">{record.message}</div>
          <div className="finding-action">{record.action}</div>
        </div>
      ),
    },
    {
      title: '资料包',
      width: 160,
      render: (_, record) =>
        data.packages.find((item) => item.id === record.packageId)?.code ?? record.packageId,
    },
  ]

  const packageColumns: TableColumnsType<MaterialPackage> = [
    { title: '编号', dataIndex: 'code', width: 135 },
    { title: '资料包', dataIndex: 'title', width: 230 },
    {
      title: '类型',
      dataIndex: 'category',
      width: 100,
      render: (value: MaterialPackage['category']) => categoryLabels[value],
    },
    { title: '目的地', dataIndex: 'destination', width: 100 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: MaterialPackage['status']) => <StatusTag status={value} />,
    },
    {
      title: '审批轮次',
      dataIndex: 'currentRound',
      width: 100,
      render: (value: number) => (value ? `第 ${value} 轮` : '未提交'),
    },
  ]

  return (
    <div>
      <PageHeader
        title="运行总览"
        description="汇总待审批资料、规则缺口、逐页核对进度和许可额度使用情况。"
        actions={
          <>
            <Button onClick={() => navigate('/page-review')}>继续逐页核对</Button>
            <Button type="primary" onClick={() => navigate('/packages')}>
              查看资料包
            </Button>
          </>
        }
      />

      <section className="metric-grid">
        <div className="metric danger">
          <span>高风险核对项</span>
          <strong>{highFindings.length}</strong>
          <small>必须解决后才能批准或扣减额度</small>
        </div>
        <div className="metric info">
          <span>处理中资料包</span>
          <strong>{activePackages.length}</strong>
          <small>审批中、已退回、已批准或已预占</small>
        </div>
        <div className="metric warning">
          <span>额度预占 / 待复核</span>
          <strong>
            {heldReservations.length} / {pendingReviewLicenses.length}
          </strong>
          <small>预占窗口互斥，待复核不释放额度</small>
        </div>
        <div className="metric">
          <span>逐页核对进度</span>
          <strong>
            {reviewedPages} / {totalPages}
          </strong>
          <Progress
            percent={totalPages ? Math.round((reviewedPages / totalPages) * 100) : 0}
            showInfo={false}
            size="small"
          />
        </div>
      </section>

      {invalidatedRoutes.length ? (
        <Alert
          showIcon
          type="warning"
          message={`${invalidatedRoutes.length} 个资料包冻结对象发生变化，未完成审批路线已即时失效，已通过步骤保留并等待重新发起。`}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {pendingReviewLicenses.length ? (
        <Alert
          showIcon
          type="error"
          message={`${pendingReviewLicenses.length} 份许可在核销后检测到冻结对象变化，已转为待复核且额度未释放，等待人工复核或撤回。`}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {highFindings.length ? (
        <Alert
          showIcon
          type="error"
          message={`当前有 ${highFindings.length} 项高风险核对结论，系统不会在资料不完整时静默批准。`}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h2>高风险与待补正项</h2>
            <Button type="link" onClick={() => navigate('/licenses')}>
              查看规则解释
            </Button>
          </div>
          <Table
            rowKey="id"
            columns={findingColumns}
            dataSource={data.findings.slice(0, 7)}
            pagination={false}
            size="small"
          />
        </section>
        <section className="panel">
          <div className="panel-title">
            <h2>合规工作摘要</h2>
            <Tag>{data.rules.length} 条许可规则</Tag>
          </div>
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <div>
              <strong>版本治理</strong>
              <p className="muted">
                每个文件保留独立版本链，审批引用版本与现行版本不一致时直接阻断。
              </p>
            </div>
            <div>
              <strong>审批路线</strong>
              <p className="muted">
                目的地、资料分类、技术参数和人员范围共同决定标准、升级或高级审批。
              </p>
            </div>
            <div>
              <strong>额度预占与核销</strong>
              <p className="muted">
                审批放行先冻结基线，额度按规则池先预占后核销；并发提交只有一个窗口成功，核销失败保留预占可幂等重试。
              </p>
            </div>
          </Space>
        </section>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h2>处理中资料包</h2>
          <Button type="link" onClick={() => navigate('/approvals')}>
            进入审批
          </Button>
        </div>
        <Table
          rowKey="id"
          columns={packageColumns}
          dataSource={activePackages}
          pagination={false}
          onRow={(record) => ({
            onClick: () => navigate(`/packages/${record.id}`),
          })}
        />
      </section>
    </div>
  )
}

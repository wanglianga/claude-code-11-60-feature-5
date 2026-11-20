import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { db } from '../db/db';
import { LevelBadge } from '../ui/widgets';

export default function Dashboard() {
  const counts = useLiveQuery(async () => ({
    batches: await db.batches.count(),
    ruleSets: await db.ruleSets.count(),
    plans: await db.plans.count(),
    runs: await db.runs.count(),
    reports: await db.reports.count(),
    manifests: await db.manifests.count(),
    calibrations: await db.calibrationReports.count()
  }), []);
  const lastRun = useLiveQuery(async () => {
    const runs = await db.runs.orderBy('seq').reverse().toArray();
    return runs[0];
  }, []);
  const lastReport = useLiveQuery(async () => (await db.reports.toArray()).pop(), []);

  return (
    <div>
      <h1 className="page-title">总览</h1>
      <p className="page-sub">
        从去标识化历史事件生成可重复的演练数据：保留报警、派车、到场、结案之间的有效关系，不复制原始个案。
        全部数据保存在本机 IndexedDB，生成与核验在 WebWorker 中执行，不调用外部服务。
      </p>

      <div className="grid3">
        {[
          { label: '来源批次（含修订）', value: counts?.batches, to: '/batches' },
          { label: '关系规则', value: counts?.ruleSets, to: '/rulesets' },
          { label: '生成方案', value: counts?.plans, to: '/plans' },
          { label: '生成运行', value: counts?.runs, to: '/runs' },
          { label: '核验报告', value: counts?.reports, to: '/reports' },
          { label: '发布清单', value: counts?.manifests, to: '/manifests' },
          { label: '学习效果校准', value: counts?.calibrations, to: '/calibration' }
        ].map((s) => (
          <div className="card" key={s.label}>
            <div className="stat-num">{s.value ?? '…'}</div>
            <div className="stat-label"><Link to={s.to}>{s.label}</Link></div>
          </div>
        ))}
      </div>

      <div className="grid2">
        <div className="card">
          <h3>操作路径</h3>
          <ol className="step-list">
            <li><b>登记来源批次</b>：在「来源批次」加载随题样例 r1（稍后可再登记迟到修订 r2），系统自动实算文件哈希并登记字段含义与修订号。</li>
            <li><b>审批关系规则</b>：在「关系规则」检查引用与先后约束（含车辆占用区间、跨午夜处理），由操作员审批。</li>
            <li><b>配置并批准方案</b>：在「生成方案」从批次学习分布、选择生成路线、设定种子与容差，通过审批门禁。</li>
            <li><b>启动生成运行</b>：在「生成运行」以固定快照输出全新标识的多表演练包。</li>
            <li><b>质量核验</b>：对运行结果执行总体统计比对、引用完整性、资源占用、时间可行性与基础风险核验。</li>
            <li><b>发布清单</b>：核验通过后生成清单，可回查批次、规则、运行参数与核验结果。</li>
            <li><b>学习效果校准</b>：把演练包场景特征与匿名学员练习顺序、决策步骤、用时、标准处置依据及迁移测验关联，估计场景难度/区分度与训练安排对未见场景正确率的效应；不生成个人排名。</li>
          </ol>
        </div>
        <div className="card">
          <h3>两条生成路线（同一关系规则、同一核验）</h3>
          <div className="method-cards">
            <div className="method-card">
              <h4>约束驱动 · 条件采样</h4>
              <ul>
                <li>逐步生成事件链，再填充属性，业务有效性容易解释</li>
                <li>稀少组合按分布精确采样，覆盖可控</li>
                <li>吞吐较低，适合中小规模（&lt;2k 事件）</li>
              </ul>
            </div>
            <div className="method-card">
              <h4>分布学习 · 批量抽样 + 约束筛选</h4>
              <ul>
                <li>先学习联合分布并批量抽样，相关性保留较好</li>
                <li>批量效率高，适合较大规模与稠密联合关系</li>
                <li>稀有模式样本少时可能失真；筛选率变化影响产量</li>
              </ul>
            </div>
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            选择依据：输入规模、联合关系稀疏度、生成速度需求。两条路线产出均须满足同一关系规则并通过相同核验。
          </p>
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <h3>最近一次运行</h3>
          {lastRun ? (
            <dl className="kv">
              <dt>运行</dt><dd><Link to="/runs">{lastRun.id}</Link>（{lastRun.method === 'constraint' ? '约束驱动' : '分布+筛选'}）</dd>
              <dt>状态</dt><dd><LevelBadge level={lastRun.status} /></dd>
              <dt>批次快照</dt><dd>{lastRun.batchKey}</dd>
              <dt>输出规模</dt><dd>{lastRun.stats ? `${lastRun.stats.events} 事件 / ${lastRun.stats.dispatches} 派遣` : '-'}</dd>
            </dl>
          ) : <div className="muted">尚无运行</div>}
        </div>
        <div className="card">
          <h3>最近一次核验</h3>
          {lastReport ? (
            <dl className="kv">
              <dt>报告</dt><dd><Link to="/reports">{lastReport.id}</Link></dd>
              <dt>结论</dt><dd><LevelBadge level={lastReport.overall} /></dd>
              <dt>风险提示</dt><dd>{lastReport.risks.length} 条</dd>
            </dl>
          ) : <div className="muted">尚无核验报告</div>}
        </div>
      </div>
    </div>
  );
}

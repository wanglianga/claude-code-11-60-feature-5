import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { startRun, getRunOutput } from '../services/runService';
import { startVerification } from '../services/verifyService';
import { exportRunPackage } from '../services/exportService';
import { LevelBadge, HashChip, Empty } from '../ui/widgets';
import { useToast } from '../ui/toast';
import { TABLE_LABELS, type Run, type TableName, type TableRows } from '../domain/types';

export default function Runs() {
  const toast = useToast();
  const plans = useLiveQuery(() => db.plans.toArray(), []);
  const runs = useLiveQuery(() => db.runs.orderBy('seq').reverse().toArray(), []);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [runningPlan, setRunningPlan] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ run: Run; tables: TableRows } | null>(null);

  const approvedPlans = plans?.filter((p) => p.status === 'approved') ?? [];

  const start = async (planId: string) => {
    const plan = await db.plans.get(planId);
    if (!plan) return;
    setRunningPlan(planId);
    setProgress({ done: 0, total: plan.targetEvents });
    const res = await startRun(plan, (done, total) => setProgress({ done, total }));
    setRunningPlan(null);
    setProgress(null);
    if (res.ok) {
      const s = res.run.stats!;
      toast(
        `运行 ${res.run.id} 完成：${s.events} 事件 / ${s.dispatches} 派遣，吞吐 ${s.throughputPerSec}/秒` +
        (s.filterRate != null ? `，筛选率 ${(s.filterRate * 100).toFixed(1)}%` : '') +
        (res.run.notice ? `；${res.run.notice}` : ''),
        'ok'
      );
    } else toast(res.error, 'bad');
  };

  const verify = async (runId: string) => {
    const res = await startVerification(runId);
    if (res.ok) toast(`核验完成：${res.report.overall}（${res.report.risks.length} 条风险提示）`, res.report.overall === 'FAIL' ? 'bad' : 'ok');
    else toast(res.error, 'bad');
  };

  const openPreview = async (run: Run) => {
    const tables = await getRunOutput(run.id);
    if (tables) setPreview({ run, tables });
  };

  return (
    <div>
      <h1 className="page-title">生成运行</h1>
      <p className="page-sub">
        在固定的来源与规则快照下输出全新标识的多表演练包。运行期间若批次被修订，当前结果继续引用启动快照，新修订另起运行。
      </p>

      <div className="card">
        <h3>启动新运行（仅已批准方案）</h3>
        {approvedPlans.length === 0 ? <Empty text="暂无已批准方案，请先在「生成方案」中批准" /> : (
          <table className="data">
            <thead><tr><th>方案</th><th>路线</th><th>目标</th><th>种子</th><th>批次快照</th><th></th></tr></thead>
            <tbody>
              {approvedPlans.map((p) => (
                <tr key={p.id}>
                  <td>{p.name} v{p.version}</td>
                  <td>{p.method === 'constraint' ? '约束驱动' : '分布+筛选'}</td>
                  <td>{p.targetEvents}</td>
                  <td>{p.seed}</td>
                  <td>{p.batchKey}</td>
                  <td>
                    <button className="primary" disabled={runningPlan !== null} onClick={() => void start(p.id)}>
                      {runningPlan === p.id ? '生成中…' : '开始生成'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {progress && (
          <div style={{ marginTop: 12 }}>
            <div className="progress-track"><div className="progress-bar" style={{ width: `${Math.min(100, (progress.done / progress.total) * 100)}%` }} /></div>
            <div className="small muted" style={{ marginTop: 4 }}>WebWorker 生成中：{progress.done} / {progress.total}</div>
          </div>
        )}
      </div>

      <div className="card">
        <h3>运行记录</h3>
        {!runs?.length ? <Empty text="尚无运行" /> : (
          <table className="data">
            <thead>
              <tr><th>运行</th><th>路线</th><th>状态</th><th>快照（批次/规则/方案）</th><th>输出规模</th><th>统计</th><th>操作</th></tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.id}</b><div className="small muted">{new Date(r.startedAt).toLocaleString()}</div></td>
                  <td>{r.method === 'constraint' ? '约束驱动' : '分布+筛选'}</td>
                  <td><LevelBadge level={r.status} /></td>
                  <td className="small">
                    {r.batchKey}<br />
                    规则 v{r.ruleSetVersion} <HashChip text={r.ruleSetHash} len={8} /><br />
                    方案 v{r.planVersion} <HashChip text={r.planHash} len={8} />
                  </td>
                  <td className="small">{r.stats ? `${r.stats.events} 事件 / ${r.stats.dispatches} 派遣 / ${r.stats.arrivals} 到场 / ${r.stats.closures} 结案` : '-'}</td>
                  <td className="small">
                    {r.stats && (
                      <>
                        吞吐 {r.stats.throughputPerSec}/秒
                        {r.stats.filterRate != null && <><br />筛选率 {(r.stats.filterRate * 100).toFixed(1)}%（候选 {r.stats.candidates}）</>}
                        {r.stats.dropped != null && r.stats.dropped > 0 && <><br />重试后丢弃 {r.stats.dropped}</>}
                      </>
                    )}
                    {r.notice && <div className="badge warn" style={{ marginTop: 4 }}>{r.notice}</div>}
                    {r.error && <div className="badge bad">{r.error}</div>}
                  </td>
                  <td>
                    {r.status === 'done' && (
                      <div className="btn-row">
                        <button onClick={() => void openPreview(r)}>查看输出</button>
                        <button className="primary" onClick={() => void verify(r.id)}>质量核验</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {preview && <OutputPreview run={preview.run} tables={preview.tables} onClose={() => setPreview(null)} />}
    </div>
  );
}

function OutputPreview({ run, tables, onClose }: { run: Run; tables: TableRows; onClose: () => void }) {
  const [tab, setTab] = useState<TableName>('events');
  const rows = tables[tab] as unknown as Record<string, string>[];
  const previewRows = rows.slice(0, 12);
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" style={{ width: 960 }} onClick={(e) => e.stopPropagation()}>
        <h3>演练包输出：{run.id}（全新标识）</h3>
        <div className="btn-row" style={{ marginBottom: 10 }}>
          <button className="primary" onClick={() => exportRunPackage(run.seq, tables, run.planSnapshot.exportFields)}>导出 CSV（按方案导出字段）</button>
          <span className="small muted">输出哈希：{Object.entries(run.outputHashes ?? {}).map(([t, h]) => `${t} ${h.slice(0, 8)}…`).join(' / ')}</span>
        </div>
        <div className="tabs">
          {(Object.keys(TABLE_LABELS) as TableName[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {TABLE_LABELS[t]}（{tables[t].length}）
            </button>
          ))}
        </div>
        <div style={{ overflowX: 'auto', maxHeight: '50vh' }}>
          <table className="data">
            <thead><tr>{previewRows[0] && Object.keys(previewRows[0]).map((k) => <th key={k}>{k}</th>)}</tr></thead>
            <tbody>
              {previewRows.map((r, i) => (
                <tr key={i}>{Object.values(r).map((v, j) => <td key={j} className="small mono">{String(v)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="btn-row" style={{ marginTop: 12 }}><button onClick={onClose}>关闭</button></div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { startVerification } from '../services/verifyService';
import { createManifest } from '../services/manifestService';
import { LevelBadge, HashChip, Empty } from '../ui/widgets';
import { useToast } from '../ui/toast';
import { useOperator } from '../App';
import type { Report } from '../domain/types';

export default function Reports() {
  const toast = useToast();
  const [operator] = useOperator();
  const reports = useLiveQuery(() => db.reports.toArray(), []);
  const runs = useLiveQuery(() => db.runs.toArray(), []);
  const [selected, setSelected] = useState<string | null>(null);

  const doneRuns = (runs ?? []).filter((r) => r.status === 'done');
  const reportedRunIds = new Set((reports ?? []).map((r) => r.runId));
  const sel = reports?.find((r) => r.id === selected);

  const verify = async (runId: string) => {
    const res = await startVerification(runId);
    if (res.ok) {
      toast(`核验完成：${res.report.overall}`, res.report.overall === 'FAIL' ? 'bad' : 'ok');
      setSelected(res.report.id);
    } else toast(res.error, 'bad');
  };

  const publish = async (runId: string) => {
    const res = await createManifest(runId, operator);
    if (res.ok) toast(`发布清单 ${res.manifest.id} 已生成`, 'ok');
    else toast(res.error, 'bad');
  };

  return (
    <div>
      <h1 className="page-title">质量核验</h1>
      <p className="page-sub">
        比较约定的总体统计、引用完整性、资源占用与时间可行性，并检查直接标识、源记录近乎复制与导出字段中的独特组合。
        两条生成路线使用完全相同的核验。
      </p>

      <div className="card">
        <h3>待核验的运行</h3>
        {doneRuns.filter((r) => !reportedRunIds.has(r.id)).length === 0 ? <Empty text="所有已完成运行均已核验" /> : (
          <div className="btn-row">
            {doneRuns.filter((r) => !reportedRunIds.has(r.id)).map((r) => (
              <button key={r.id} className="primary" onClick={() => void verify(r.id)}>核验 {r.id}</button>
            ))}
          </div>
        )}
      </div>

      {!reports?.length ? <div className="card"><Empty text="尚无核验报告" /></div> : reports
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((r) => (
          <div className="card" key={r.id}>
            <div className="btn-row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>{r.id} <span className="muted">（{r.runId}）</span></h3>
              <div className="btn-row">
                <LevelBadge level={r.overall} />
                <button onClick={() => setSelected(selected === r.id ? null : r.id)}>{selected === r.id ? '收起' : '查看报告'}</button>
                {r.overall !== 'FAIL' && <button className="primary" onClick={() => void publish(r.runId)}>生成发布清单</button>}
              </div>
            </div>
            <div className="small muted" style={{ marginTop: 6 }}>
              {new Date(r.createdAt).toLocaleString()} · 报告哈希 <HashChip text={r.hash} len={16} /> · 风险提示 {r.risks.length} 条
            </div>
            {selected === r.id && <ReportView report={r} />}
          </div>
        ))}
    </div>
  );
}

function ReportView({ report }: { report: Report }) {
  return (
    <div style={{ marginTop: 12 }}>
      {report.sections.map((s) => (
        <div key={s.key} className="card" style={{ background: '#fafbfe' }}>
          <div className="btn-row" style={{ justifyContent: 'space-between' }}>
            <h4 style={{ margin: 0 }}>{s.title}</h4>
            <LevelBadge level={s.level} />
          </div>
          <table className="data" style={{ marginTop: 8 }}>
            <thead><tr><th>检查项</th><th>结论</th><th>源数据</th><th>合成数据</th><th>容差</th><th>说明</th></tr></thead>
            <tbody>
              {s.items.map((it, i) => (
                <tr key={i}>
                  <td className="small">{it.label}</td>
                  <td><LevelBadge level={it.level} /></td>
                  <td className="small">{it.source ?? '-'}</td>
                  <td className="small">{it.synthetic ?? '-'}</td>
                  <td className="small">{it.tol ?? '-'}</td>
                  <td className="small">{it.detail ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div className={`notice ${report.risks.length ? 'warn' : 'ok'}`}>
        <b>风险提示（{report.risks.length}）</b>
        {report.risks.length > 0 && (
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {report.risks.map((r, i) => (
              <li key={i}>
                <span className={`badge ${r.level === 'high' ? 'bad' : r.level === 'medium' ? 'warn' : ''}`}>{r.kind}</span>{' '}
                {r.message}{r.detail ? <span className="muted">（{r.detail}）</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="notice info small"><b>核验范围声明：</b>{report.disclaimer}</div>
    </div>
  );
}

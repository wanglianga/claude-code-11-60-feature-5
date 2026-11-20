import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { recheckManifest } from '../domain/manifest';
import { exportJson } from '../services/exportService';
import { LevelBadge, HashChip, Empty } from '../ui/widgets';
import { useToast } from '../ui/toast';
import type { Manifest } from '../domain/types';

export default function Manifests() {
  const toast = useToast();
  const manifests = useLiveQuery(() => db.manifests.toArray(), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [recheck, setRecheck] = useState<Record<string, { item: string; expected: string; actual: string; ok: boolean }[]>>({});

  const doRecheck = async (m: Manifest) => {
    const batch = await db.batches.get(m.batch.batchKey);
    const report = await db.reports.get(m.report.id);
    const rows = await recheckManifest(m, { batch, reportHash: report?.hash });
    setRecheck((r) => ({ ...r, [m.id]: rows }));
    if (rows.every((x) => x.ok)) toast('回查校验一致：清单内容与当前库存快照吻合', 'ok');
    else toast('回查发现不一致项，请检查', 'bad');
  };

  return (
    <div>
      <h1 className="page-title">发布清单</h1>
      <p className="page-sub">
        清单由输入计算产生：来源批次（修订号 + 文件哈希）、关系规则、运行参数（方法/种子/规模）与核验结果全部可回查。
      </p>

      {!manifests?.length ? <div className="card"><Empty text="尚无发布清单。请在「质量核验」中对通过的运行生成清单。" /></div> : manifests
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((m) => (
          <div className="card" key={m.id}>
            <div className="btn-row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>{m.id} <span className="muted">（{m.run.id}）</span></h3>
              <div className="btn-row">
                <LevelBadge level={m.report.overall as 'PASS' | 'WARN' | 'FAIL'} />
                <button onClick={() => setSelected(selected === m.id ? null : m.id)}>{selected === m.id ? '收起' : '回查视图'}</button>
                <button onClick={() => void doRecheck(m)}>重新校验</button>
                <button className="primary" onClick={() => exportJson(`${m.id}.json`, m)}>导出清单 JSON</button>
              </div>
            </div>
            <div className="small muted" style={{ marginTop: 6 }}>
              {m.createdBy} · {new Date(m.createdAt).toLocaleString()} · 清单哈希 <HashChip text={m.manifestHash} len={20} />
            </div>

            {selected === m.id && (
              <div style={{ marginTop: 12 }}>
                <div className="grid2">
                  <div className="card" style={{ background: '#fafbfe' }}>
                    <h4>① 来源批次</h4>
                    <dl className="kv">
                      <dt>批次 / 修订</dt><dd>{m.batch.batchId} @ r{m.batch.revision}</dd>
                      <dt>文件哈希</dt>
                      <dd>{Object.entries(m.batch.fileHashes).map(([n, h]) => (
                        <div key={n} className="small">{n} <HashChip text={h} len={14} /></div>
                      ))}</dd>
                    </dl>
                  </div>
                  <div className="card" style={{ background: '#fafbfe' }}>
                    <h4>② 关系规则</h4>
                    <dl className="kv">
                      <dt>规则</dt><dd>{m.ruleSet.id} v{m.ruleSet.version}</dd>
                      <dt>哈希</dt><dd><HashChip text={m.ruleSet.hash} len={20} /></dd>
                      <dt>审批人</dt><dd>{m.ruleSet.approvedBy ?? '-'}</dd>
                    </dl>
                  </div>
                  <div className="card" style={{ background: '#fafbfe' }}>
                    <h4>③ 运行参数</h4>
                    <dl className="kv">
                      <dt>方案</dt><dd>{m.plan.id} v{m.plan.version} <HashChip text={m.plan.hash} len={10} /></dd>
                      <dt>路线 / 种子</dt><dd>{m.plan.method === 'constraint' ? '约束驱动' : '分布+筛选'} · 种子 {m.plan.seed}</dd>
                      <dt>目标规模</dt><dd>{m.plan.targetEvents} 事件</dd>
                      <dt>运行</dt><dd>{m.run.id} · {new Date(m.run.startedAt).toLocaleString()}</dd>
                      <dt>输出哈希</dt>
                      <dd>{Object.entries(m.run.outputHashes ?? {}).map(([t, h]) => (
                        <div key={t} className="small">{t} <HashChip text={h} len={12} /></div>
                      ))}</dd>
                    </dl>
                  </div>
                  <div className="card" style={{ background: '#fafbfe' }}>
                    <h4>④ 核验结果</h4>
                    <dl className="kv">
                      <dt>报告</dt><dd>{m.report.id} <LevelBadge level={m.report.overall as 'PASS' | 'WARN' | 'FAIL'} /></dd>
                      <dt>报告哈希</dt><dd><HashChip text={m.report.hash} len={20} /></dd>
                      <dt>风险提示</dt><dd>{m.report.riskCount} 条</dd>
                    </dl>
                  </div>
                </div>
                {recheck[m.id] && (
                  <div className={`notice ${recheck[m.id].every((x) => x.ok) ? 'ok' : 'bad'}`}>
                    <b>回查校验：</b>
                    <table className="data" style={{ marginTop: 6 }}>
                      <thead><tr><th>项</th><th>清单记录</th><th>当前重算</th><th>结论</th></tr></thead>
                      <tbody>
                        {recheck[m.id].map((r, i) => (
                          <tr key={i}>
                            <td className="small">{r.item}</td>
                            <td className="mono small">{r.expected}</td>
                            <td className="mono small">{r.actual}</td>
                            <td>{r.ok ? <span className="badge ok">一致</span> : <span className="badge bad">不一致</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}

import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { loadBundledSample, inspectBatch, registerBatch } from '../services/batchService';
import { LevelBadge, HashChip, Empty } from '../ui/widgets';
import { useToast } from '../ui/toast';
import { TABLE_LABELS, type BatchMeta, type TableName } from '../domain/types';

export default function Batches() {
  const toast = useToast();
  const batches = useLiveQuery(() => db.batches.orderBy('key').toArray(), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  const load = async (rev: 1 | 2) => {
    setBusy(true);
    const res = await loadBundledSample(rev);
    setBusy(false);
    if (res.ok) toast(`批次 ${res.batch.key} 登记完成（${res.batch.files.length} 个文件，哈希已实算）`, 'ok');
    else toast(res.error, 'bad');
  };

  const onUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const map = new Map<string, string>();
    for (const f of Array.from(files)) map.set(f.name, await f.text());
    const batchJson = map.get('batch.json');
    if (!batchJson) { toast('上传文件中缺少 batch.json', 'bad'); return; }
    const csvByTable: Record<string, { name: string; text: string }> = {};
    for (const t of ['events', 'dispatches', 'resources', 'arrivals', 'closures']) {
      const text = map.get(`${t}.csv`);
      if (text) csvByTable[t] = { name: `${t}.csv`, text };
    }
    setBusy(true);
    const res = await registerBatch({ batchJson, fieldsJson: map.get('fields.json'), csvByTable: csvByTable as never });
    setBusy(false);
    if (res.ok) toast(`批次 ${res.batch.key} 登记完成`, 'ok');
    else toast(res.error, 'bad');
  };

  const inspect = async (key: string) => {
    const res = await inspectBatch(key);
    setIssues((m) => ({ ...m, [key]: res }));
  };

  const sel = batches?.find((b) => b.key === selected);

  return (
    <div>
      <h1 className="page-title">来源批次</h1>
      <p className="page-sub">
        登记去标识化来源数据：实算每个文件的 SHA-256 并与 batch.json 声明值比对，登记字段含义与修订号。
        批次内容按修订号不可变存储——运行中的任务继续引用启动快照，新修订另起运行。
      </p>

      <div className="card">
        <h3>登记批次</h3>
        <div className="btn-row">
          <button className="primary" disabled={busy} onClick={() => load(1)}>加载随题样例 r1（首批登记）</button>
          <button className="primary" disabled={busy} onClick={() => load(2)}>加载随题样例 r2（迟到源修订）</button>
          <label className="btn">
            上传文件登记
            <input type="file" multiple accept=".csv,.json" style={{ display: 'none' }}
              onChange={(e) => { void onUpload(e.target.files); e.target.value = ''; }} />
          </label>
          {busy && <span className="muted small">登记中…</span>}
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          演示「迟到源修订」：先登记 r1 并完成一次生成运行，再登记 r2 —— 已完成的运行仍引用 r1 快照，新运行默认使用 r2。
        </p>
      </div>

      <div className="card">
        <h3>已登记批次</h3>
        {!batches?.length ? <Empty text="尚未登记批次" /> : (
          <table className="data">
            <thead>
              <tr><th>批次</th><th>修订</th><th>状态</th><th>文件（哈希实算 / 声明比对）</th><th>登记时间</th><th>操作</th></tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.key}>
                  <td><b>{b.batchId}</b><div className="small muted">{b.note}</div></td>
                  <td>r{b.revision}</td>
                  <td><LevelBadge level={b.status} /></td>
                  <td>
                    {b.files.map((f) => (
                      <div key={f.name} className="small">
                        {f.name}（{f.rows} 行）<HashChip text={f.sha256} len={10} />{' '}
                        {f.declaredSha256
                          ? f.hashMatch
                            ? <span className="badge ok">与声明一致</span>
                            : <span className="badge bad">与声明不符</span>
                          : <span className="badge">无声明值</span>}
                      </div>
                    ))}
                  </td>
                  <td className="small">{new Date(b.registeredAt).toLocaleString()}<br /><span className="muted">声明发布：{b.declaredAt || '-'}</span></td>
                  <td>
                    <div className="btn-row">
                      <button onClick={() => setSelected(selected === b.key ? null : b.key)}>{selected === b.key ? '收起' : '详情'}</button>
                      <button onClick={() => void inspect(b.key)}>源数据体检</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {Object.entries(issues).map(([key, list]) => (
          <div key={key} className={`notice ${list.length === 1 && list[0].includes('未发现') ? 'ok' : 'warn'}`} style={{ marginTop: 12 }}>
            <b>{key} 源数据体检：</b>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {list.slice(0, 12).map((i, idx) => <li key={idx}>{i}</li>)}
              {list.length > 12 && <li>…共 {list.length} 条</li>}
            </ul>
          </div>
        ))}
      </div>

      {sel && <BatchDetail batch={sel} />}
    </div>
  );
}

function BatchDetail({ batch }: { batch: BatchMeta }) {
  const rows = useLiveQuery(() => db.batchRows.get(batch.key), [batch.key]);
  const [tab, setTab] = useState<TableName>('events');
  const preview = (rows?.tables[tab] ?? []).slice(0, 8);

  return (
    <div className="card">
      <h3>批次详情：{batch.key}</h3>
      {batch.changes.length > 0 && (
        <div className="notice info">
          <b>本修订变更：</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{batch.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </div>
      )}
      <h4>字段含义（fields.json）</h4>
      {batch.fieldDict ? (
        <table className="data">
          <thead><tr><th>表</th><th>字段</th><th>含义</th><th>类型</th><th>角色</th></tr></thead>
          <tbody>
            {Object.entries(batch.fieldDict).flatMap(([t, def]) =>
              def.fields.map((f) => (
                <tr key={`${t}.${f.name}`}>
                  <td>{def.label}</td><td className="mono">{f.name}</td><td>{f.meaning}</td><td>{f.type}</td>
                  <td><span className={`badge ${f.role === 'direct' ? 'bad' : f.role === 'quasi' ? 'warn' : f.role === 'identifier' ? 'info' : ''}`}>{f.role}</span></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      ) : <div className="muted small">未登记字段字典</div>}

      <h4 style={{ marginTop: 16 }}>数据预览</h4>
      <div className="tabs">
        {(Object.keys(TABLE_LABELS) as TableName[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {TABLE_LABELS[t]}（{rows?.tables[t].length ?? 0}）
          </button>
        ))}
      </div>
      {preview.length === 0 ? <Empty text="无数据" /> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data">
            <thead><tr>{Object.keys(preview[0]).map((k) => <th key={k}>{k}</th>)}</tr></thead>
            <tbody>
              {preview.map((r, i) => (
                <tr key={i}>{Object.values(r).map((v, j) => <td key={j} className="small">{String(v)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

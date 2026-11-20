import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { savePlan, approvePlan, duplicatePlan } from '../services/planService';
import { defaultPlan, lintPlan } from '../domain/defaults';
import { learnDistributions } from '../domain/stats';
import { LevelBadge, Empty } from '../ui/widgets';
import { useToast } from '../ui/toast';
import { useOperator } from '../App';
import type { Plan, ConflictField, GenMethod } from '../domain/types';
import { PATTERN_LABELS } from '../domain/stats';

export default function Plans() {
  const toast = useToast();
  const [operator] = useOperator();
  const plans = useLiveQuery(() => db.plans.toArray(), []);
  const batches = useLiveQuery(() => db.batches.toArray(), []);
  const ruleSets = useLiveQuery(() => db.ruleSets.toArray(), []);
  const [editing, setEditing] = useState<{ plan: Plan; baseVersion: number } | null>(null);
  const [conflict, setConflict] = useState<{ conflicts: ConflictField[] } | null>(null);

  const approvedRuleSets = ruleSets?.filter((r) => r.status === 'approved') ?? [];
  const latestBatches = batches?.filter((b) => b.status === 'latest') ?? [];

  const create = async () => {
    const batch = latestBatches[0];
    const rs = approvedRuleSets[0];
    if (!batch) { toast('请先在「来源批次」登记批次', 'bad'); return; }
    if (!rs) { toast('请先在「关系规则」审批一条规则', 'bad'); return; }
    const rows = (await db.batchRows.get(batch.key))!.tables;
    const plan = defaultPlan(`PL-${Date.now().toString(36)}`, batch.key, rs.id, rs.version, rows, new Date().toISOString());
    await db.plans.put(plan);
    setEditing({ plan, baseVersion: 0 });
    toast('已按来源批次初始化方案草稿', 'ok');
  };

  const save = async (force = false) => {
    if (!editing) return;
    const res = await savePlan(editing.plan, editing.baseVersion, { force });
    if (res.ok) {
      toast(`方案已保存（v${res.plan.version}）`, 'ok');
      setEditing({ plan: res.plan, baseVersion: res.plan.version });
      setConflict(null);
    } else if (res.conflict) {
      setConflict({ conflicts: res.conflicts });
    } else {
      toast(res.error, 'bad');
    }
  };

  const approve = async (id: string) => {
    const res = await approvePlan(id, operator);
    if (res.ok) toast(`方案已由 ${operator} 批准`, 'ok');
    else toast(`审批被拒绝：${res.errors[0]}${res.errors.length > 1 ? ` 等 ${res.errors.length} 项` : ''}`, 'bad');
    return res;
  };

  const [lastReject, setLastReject] = useState<string[]>([]);

  return (
    <div>
      <h1 className="page-title">生成方案</h1>
      <p className="page-sub">
        方案记录要保留的全局事件类型、时长分布与随机种子，并选择生成路线。
        保存采用乐观锁：两名管理员并发保存同一方案时，后保存者将看到冲突字段；未审或宽松的规则不能进入已批准方案。
      </p>

      <div className="card">
        <div className="btn-row">
          <button className="primary" onClick={() => void create()}>新建方案（从最新批次学习分布）</button>
        </div>
        {lastReject.length > 0 && (
          <div className="notice bad" style={{ marginTop: 12 }}>
            <b>审批被拒绝：</b>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{lastReject.map((e, i) => <li key={i}>{e}</li>)}</ul>
          </div>
        )}
      </div>

      {!plans?.length ? <div className="card"><Empty text="尚无方案" /></div> : plans
        .slice()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((p) => (
          <div className="card" key={p.id}>
            <div className="btn-row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>{p.name} <span className="muted">v{p.version}</span></h3>
              <div className="btn-row">
                <LevelBadge level={p.status} />
                {p.status === 'draft' && (
                  <button className="primary" onClick={async () => {
                    const res = await approve(p.id);
                    setLastReject(res.ok ? [] : res.errors);
                  }}>批准（{operator}）</button>
                )}
                <button onClick={() => setEditing({ plan: structuredClone(p), baseVersion: p.version })}>
                  {p.status === 'approved' ? '查看' : '编辑'}
                </button>
                <button onClick={async () => { const c = await duplicatePlan(p); toast(`已另存为「${c.name}」`, 'ok'); }}>另存副本</button>
              </div>
            </div>
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>生成路线</dt><dd>{p.method === 'constraint' ? '约束驱动 · 条件采样' : '分布学习 · 批量抽样+筛选'}</dd>
              <dt>目标 / 种子</dt><dd>{p.targetEvents} 事件 · 种子 {p.seed} · {p.dateRange.start.slice(0, 10)} 起 {p.dateRange.days} 天</dd>
              <dt>来源批次</dt><dd>{p.batchKey}</dd>
              <dt>引用规则</dt><dd>{p.ruleSetId} v{p.ruleSetVersion}</dd>
              <dt>声明组合</dt><dd className="small">{p.quasiCombos.map((c) => `[${c.join('+')}]`).join(' ')}</dd>
              {p.approvedBy && <><dt>批准</dt><dd>{p.approvedBy} · {new Date(p.approvedAt!).toLocaleString()}</dd></>}
              {p.approvalChecks && <><dt>审批检查</dt><dd className="small">{p.approvalChecks.join('；')}</dd></>}
            </dl>
          </div>
        ))}

      {editing && (
        <PlanEditor
          editing={editing}
          setEditing={setEditing}
          onSave={() => void save(false)}
          onClose={() => { setEditing(null); setConflict(null); }}
          batches={batches ?? []}
          ruleSets={ruleSets ?? []}
        />
      )}

      {conflict && editing && (
        <div className="modal-mask" onClick={() => setConflict(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>保存冲突：另一管理员已修改此方案</h3>
            <p className="muted small">以下字段存在冲突（你的修改 vs 库中当前值）。请选择「覆盖保存」或「放弃并重新加载」。</p>
            <table className="data">
              <thead><tr><th>字段</th><th>你的值</th><th>库中当前值</th></tr></thead>
              <tbody>
                {conflict.conflicts.map((c) => (
                  <tr key={c.field}><td className="mono">{c.field}</td><td className="small">{c.yours}</td><td className="small">{c.current}</td></tr>
                ))}
              </tbody>
            </table>
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button className="danger" onClick={() => void save(true)}>覆盖保存（以我的为准）</button>
              <button onClick={async () => {
                const cur = await db.plans.get(editing.plan.id);
                if (cur) setEditing({ plan: cur, baseVersion: cur.version });
                setConflict(null);
                toast('已重新加载库中版本', 'info');
              }}>放弃并重新加载</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PlanEditor({ editing, setEditing, onSave, onClose, batches, ruleSets }: {
  editing: { plan: Plan; baseVersion: number };
  setEditing: (v: { plan: Plan; baseVersion: number }) => void;
  onSave: () => void;
  onClose: () => void;
  batches: { key: string }[];
  ruleSets: { id: string; version: number; status: string; name: string }[];
}) {
  const toast = useToast();
  const p = editing.plan;
  const set = (patch: Partial<Plan>) => setEditing({ ...editing, plan: { ...p, ...patch } });
  const lint = lintPlan(p);
  const readOnly = p.status === 'approved';

  const relearn = async () => {
    const rows = (await db.batchRows.get(p.batchKey))?.tables;
    if (!rows) { toast('批次数据缺失', 'bad'); return; }
    set({ distributions: learnDistributions(rows) });
    toast(`已从 ${p.batchKey} 重新学习分布`, 'ok');
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" style={{ width: 860 }} onClick={(e) => e.stopPropagation()}>
        <h3>{readOnly ? '查看' : '编辑'}方案（基准版本 v{editing.baseVersion}）</h3>
        <fieldset disabled={readOnly} style={{ border: 'none', padding: 0, margin: 0 }}>
          <div className="grid2">
            <label className="field"><span>方案名称</span>
              <input value={p.name} onChange={(e) => set({ name: e.target.value })} /></label>
            <label className="field"><span>来源批次（分布学习来源）</span>
              <select value={p.batchKey} onChange={(e) => set({ batchKey: e.target.value })}>
                {batches.map((b) => <option key={b.key} value={b.key}>{b.key}</option>)}
              </select></label>
            <label className="field"><span>引用规则（须已审批）</span>
              <select value={p.ruleSetId} onChange={(e) => {
                const rs = ruleSets.find((r) => r.id === e.target.value);
                set({ ruleSetId: e.target.value, ruleSetVersion: rs?.version ?? p.ruleSetVersion });
              }}>
                {ruleSets.map((r) => (
                  <option key={r.id} value={r.id}>{r.name} v{r.version}{r.status === 'approved' ? '（已审批）' : '（草稿！）'}</option>
                ))}
              </select></label>
            <label className="field"><span>随机种子（整数，可复现）</span>
              <input type="number" value={p.seed} onChange={(e) => set({ seed: Math.floor(Number(e.target.value)) })} /></label>
            <label className="field"><span>目标事件数</span>
              <input type="number" value={p.targetEvents} onChange={(e) => set({ targetEvents: Number(e.target.value) })} /></label>
            <label className="field"><span>生成起始日 / 跨度（天）</span>
              <span style={{ display: 'flex', gap: 6 }}>
                <input type="date" value={p.dateRange.start.slice(0, 10)}
                  onChange={(e) => set({ dateRange: { ...p.dateRange, start: `${e.target.value} 00:00:00` } })} />
                <input type="number" style={{ width: 90 }} value={p.dateRange.days}
                  onChange={(e) => set({ dateRange: { ...p.dateRange, days: Number(e.target.value) } })} />
              </span></label>
          </div>

          <h4>生成路线选择（依据：输入规模 / 联合关系稀疏度 / 速度需求）</h4>
          <div className="method-cards">
            {([
              { m: 'constraint' as GenMethod, t: '约束驱动 · 条件采样', d: '逐步生成事件链再填属性；稀少组合覆盖可控；吞吐较低，适合 <2k 事件与稀疏联合关系。' },
              { m: 'joint-filter' as GenMethod, t: '分布学习 · 批量抽样+筛选', d: '学习联合分布后批量抽样，再以同一约束筛选；相关性保留好、批量快；稀有模式可能失真，筛选率影响产量。' }
            ]).map((opt) => (
              <div key={opt.m} className={`method-card ${p.method === opt.m ? 'selected' : ''}`}
                onClick={() => set({ method: opt.m })}>
                <h4>{opt.t}</h4>
                <p className="small muted" style={{ margin: 0 }}>{opt.d}</p>
              </div>
            ))}
          </div>

          <h4 style={{ marginTop: 14 }}>资源池（合成车辆数）</h4>
          <div className="grid3">
            <label className="field"><span>救护车</span>
              <input type="number" value={p.resourcePool.ambulances}
                onChange={(e) => set({ resourcePool: { ...p.resourcePool, ambulances: Number(e.target.value) } })} /></label>
            <label className="field"><span>消防车</span>
              <input type="number" value={p.resourcePool.fireTrucks}
                onChange={(e) => set({ resourcePool: { ...p.resourcePool, fireTrucks: Number(e.target.value) } })} /></label>
            <label className="field"><span>危化专勤车</span>
              <input type="number" value={p.resourcePool.hazmat}
                onChange={(e) => set({ resourcePool: { ...p.resourcePool, hazmat: Number(e.target.value) } })} /></label>
          </div>

          <h4>核验容差（审批门禁将拒绝超出系统边界的宽松参数）</h4>
          <div className="grid3">
            <label className="field"><span>类型占比容差 pp（1~10）</span>
              <input type="number" value={p.tolerances.typeMixPP}
                onChange={(e) => set({ tolerances: { ...p.tolerances, typeMixPP: Number(e.target.value) } })} /></label>
            <label className="field"><span>直方图单桶容差 pp（2~15）</span>
              <input type="number" value={p.tolerances.histPP}
                onChange={(e) => set({ tolerances: { ...p.tolerances, histPP: Number(e.target.value) } })} /></label>
            <label className="field"><span>均值相对容差 %（5~25）</span>
              <input type="number" value={p.tolerances.meanRelPct}
                onChange={(e) => set({ tolerances: { ...p.tolerances, meanRelPct: Number(e.target.value) } })} /></label>
            <label className="field"><span>日量相对容差 %（5~40）</span>
              <input type="number" value={p.tolerances.volumeRelPct}
                onChange={(e) => set({ tolerances: { ...p.tolerances, volumeRelPct: Number(e.target.value) } })} /></label>
            <label className="field"><span>近乎复制告警 / 失败</span>
              <span style={{ display: 'flex', gap: 6 }}>
                <input type="number" step="0.01" value={p.tolerances.nearCopyWarn}
                  onChange={(e) => set({ tolerances: { ...p.tolerances, nearCopyWarn: Number(e.target.value) } })} />
                <input type="number" step="0.01" value={p.tolerances.nearCopyFail}
                  onChange={(e) => set({ tolerances: { ...p.tolerances, nearCopyFail: Number(e.target.value) } })} />
              </span></label>
            <label className="field"><span>独特组合 k 阈值（2~10）</span>
              <input type="number" value={p.tolerances.kAnonymity}
                onChange={(e) => set({ tolerances: { ...p.tolerances, kAnonymity: Number(e.target.value) } })} /></label>
          </div>

          <h4>声明字段组合（独特性检查，每行一个组合，字段以 + 连接）</h4>
          <textarea rows={2} style={{ width: '100%' }}
            value={p.quasiCombos.map((c) => c.join('+')).join('\n')}
            onChange={(e) => set({ quasiCombos: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean).map((s) => s.split('+').map((x) => x.trim())) })} />
          <p className="small muted">可用字段：event_type / district / priority / chain_pattern / outcome / alarm_hour</p>

          <h4>保留分布 <button className="btn small" onClick={(e) => { e.preventDefault(); void relearn(); }}>从批次重新学习</button></h4>
          <DistView plan={p} />
        </fieldset>

        {lint.length > 0 && !readOnly && (
          <div className="notice warn" style={{ marginTop: 10 }}>
            <b>审批前需修正：</b>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{lint.map((e, i) => <li key={i}>{e}</li>)}</ul>
          </div>
        )}
        <div className="btn-row" style={{ marginTop: 14 }}>
          {!readOnly && <button className="primary" onClick={onSave}>保存</button>}
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

function DistView({ plan }: { plan: Plan }) {
  const d = plan.distributions;
  const mixRow = (title: string, mix: Record<string, number>) => (
    <div className="small" style={{ marginBottom: 4 }}>
      <b>{title}：</b>
      {Object.entries(mix).map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`).join('，')}
    </div>
  );
  return (
    <div className="card" style={{ background: '#fafbfe' }}>
      {mixRow('事件类型', d.eventTypeMix)}
      {mixRow('行政区', d.districtMix)}
      <div className="small" style={{ marginBottom: 4 }}>
        <b>链型（按类型）：</b>
        {Object.entries(d.chainPatternMixByType).map(([t, m]) => (
          <span key={t} style={{ marginRight: 12 }}>
            {t}: {Object.entries(m).map(([k, v]) => `${PATTERN_LABELS[k as keyof typeof PATTERN_LABELS] ?? k} ${(v * 100).toFixed(0)}%`).join('/')}
          </span>
        ))}
      </div>
      <div className="hist-wrap">
        {(['response', 'travel', 'onScene', 'total'] as const).map((key) => {
          const h = d.durationHists[key];
          const max = Math.max(...h.counts, 1);
          const titles = { response: '响应时长', travel: '行驶时长', onScene: '现场处置', total: '全程时长' };
          return (
            <div className="hist-col" key={key}>
              <div className="hist">
                {h.counts.map((c, i) => (
                  <div key={i} className="bar" style={{ height: `${(c / max) * 100}%` }} title={`${h.edges[i]}~${h.edges[i + 1] ?? '∞'}分: ${c}`} />
                ))}
              </div>
              <div className="hist-legend">{titles[key]}（{h.edges[0]}~{h.edges[h.edges.length - 1]}分）</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

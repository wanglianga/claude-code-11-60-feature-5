import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { createDefaultRuleSet, saveRuleSet, approveRuleSet } from '../services/ruleSetService';
import { LevelBadge, HashChip, Empty } from '../ui/widgets';
import { useToast } from '../ui/toast';
import { useOperator } from '../App';
import type { RuleSet } from '../domain/types';
import { EVENT_TYPES } from '../domain/defaults';

const BOUND_LABELS: Record<string, string> = {
  responseMaxMin: '响应上限（报警→派遣，分）',
  travelMaxMin: '行驶上限（派遣→到场，分）',
  onSceneMaxMin: '现场处置上限（末次到场→结案，分）',
  totalMaxMin: '全程上限（报警→结案，分）',
  turnoverMin: '车辆周转（占用区间延长，分）',
  transferGapMin: '转运交接最小间隔（分）'
};
const ALL_CAPS = ['急救', '转运', '消防', '危化'];

export default function RuleSets() {
  const toast = useToast();
  const [operator] = useOperator();
  const ruleSets = useLiveQuery(() => db.ruleSets.toArray(), []);
  const [editing, setEditing] = useState<RuleSet | null>(null);

  const create = async () => {
    const rs = await createDefaultRuleSet();
    setEditing(rs);
    toast('已创建标准规则草稿，请检查后审批', 'ok');
  };

  const save = async () => {
    if (!editing) return;
    const saved = await saveRuleSet(editing);
    setEditing(saved.status === 'draft' && saved.version > 1 ? null : saved);
    if (saved.version > 1 && saved.status === 'draft') toast(`原规则已审批，修改已另存为 v${saved.version} 草稿（需重新审批）`, 'info');
    else toast('规则已保存', 'ok');
  };

  const approve = async (id: string) => {
    const res = await approveRuleSet(id, operator);
    if (res.ok) toast(`规则已由 ${operator} 审批`, 'ok');
    else toast(res.error ?? '审批失败', 'bad');
  };

  return (
    <div>
      <h1 className="page-title">关系规则</h1>
      <p className="page-sub">
        描述事件、派遣、资源、到场、结案之间的引用及先后约束。已审批规则不可原地修改，再次编辑自动生成新版本草稿。
      </p>

      <div className="card">
        <div className="btn-row">
          <button className="primary" onClick={() => void create()}>新建标准规则</button>
        </div>
      </div>

      {!ruleSets?.length ? <div className="card"><Empty text="尚无规则，请先新建" /></div> : ruleSets
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version)
        .map((rs) => (
          <div className="card" key={`${rs.id}@${rs.version}`}>
            <div className="btn-row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>{rs.name} <span className="muted">v{rs.version}</span></h3>
              <div className="btn-row">
                <LevelBadge level={rs.status} />
                {rs.status === 'draft' && <button className="primary" onClick={() => void approve(rs.id)}>审批（{operator}）</button>}
                <button onClick={() => setEditing(structuredClone(rs))}>{rs.status === 'approved' ? '查看/派生新版本' : '编辑'}</button>
              </div>
            </div>
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>哈希</dt><dd><HashChip text={rs.hash} len={20} /></dd>
              {rs.approvedBy && <><dt>审批</dt><dd>{rs.approvedBy} · {new Date(rs.approvedAt!).toLocaleString()}</dd></>}
              <dt>引用约束</dt>
              <dd className="small">
                派遣.event_id → 事件；派遣.resource_id → 资源；到场.dispatch_id → 派遣；结案.event_id → 事件；
                每事件 ≥1 派遣且恰 1 结案；每派遣至多 1 到场。
              </dd>
              <dt>先后约束</dt>
              <dd className="small">
                报警 ≤ 派遣 ≤ 到场 ≤ 结案；转运链：下一程派遣 ≥ 上一程到场 + {rs.bounds.transferGapMin} 分；
                车辆占用区间 = [派遣， 到场 + {rs.bounds.turnoverMin} 分周转]，按绝对时间核验（跨午夜不算日期倒序）。
              </dd>
              <dt>时长边界</dt>
              <dd className="small">
                响应 ≤ {rs.bounds.responseMaxMin} 分；行驶 ≤ {rs.bounds.travelMaxMin} 分；现场处置 ≤ {rs.bounds.onSceneMaxMin} 分；全程 ≤ {rs.bounds.totalMaxMin} 分
              </dd>
              <dt>能力映射</dt>
              <dd className="small">{Object.entries(rs.capabilityMap).map(([t, caps]) => `${t}→${caps.join('/')}`).join('；')}</dd>
            </dl>
          </div>
        ))}

      {editing && (
        <div className="modal-mask" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>编辑规则（{editing.status === 'approved' ? '保存后生成新版本草稿' : `v${editing.version}`}）</h3>
            <label className="field"><span>规则名称</span>
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <h4>时长边界与占用参数</h4>
            <div className="grid2">
              {Object.entries(BOUND_LABELS).map(([k, label]) => (
                <label className="field" key={k}><span>{label}</span>
                  <input type="number" value={(editing.bounds as never)[k]}
                    onChange={(e) => setEditing({ ...editing, bounds: { ...editing.bounds, [k]: Number(e.target.value) } })} />
                </label>
              ))}
            </div>
            <h4>事件类型 → 所需能力</h4>
            {EVENT_TYPES.map((t) => (
              <div key={t} className="btn-row" style={{ marginBottom: 6 }}>
                <span style={{ width: 90 }}>{t}</span>
                {ALL_CAPS.map((cap) => {
                  const has = (editing.capabilityMap[t] ?? []).includes(cap);
                  return (
                    <label key={cap} className="small" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input type="checkbox" checked={has}
                        onChange={(e) => {
                          const cur = new Set(editing.capabilityMap[t] ?? []);
                          if (e.target.checked) cur.add(cap); else cur.delete(cap);
                          setEditing({ ...editing, capabilityMap: { ...editing.capabilityMap, [t]: [...cur] } });
                        }} />
                      {cap}
                    </label>
                  );
                })}
              </div>
            ))}
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button className="primary" onClick={() => void save()}>保存</button>
              <button onClick={() => setEditing(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 基础风险核验：直接标识扫描、源记录近乎复制检测、已声明字段组合的独特性检查。
// 注意：本模块只覆盖上述三类约定检查，不宣称能抵御针对特定目标的定制攻击。

import type { TableRows, Plan } from './types';
import { buildChains } from './stats';
import { parseTs } from './time';

export interface DirectHit {
  table: string;
  rowId: string;
  field: string;
  value: string;
  reason: string;
}

const RE_PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const RE_IDCARD = /(?<![\dXx])\d{17}[\dXx](?!\d)/;
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const RE_BANK = /(?<!\d)(?:\d[ -]?){15,19}(?!\d)/;

/** 直接标识扫描：对导出字段做模式匹配 + 与源直接字段逐字比对 */
export function scanDirectIdentifiers(
  syn: TableRows,
  src: TableRows,
  exportFields: Record<string, string[]>
): DirectHit[] {
  const hits: DirectHit[] = [];
  const srcDirectValues = new Map<string, Set<string>>();
  const collect = (table: keyof TableRows, field: string) => {
    const key = `${table}.${field}`;
    if (!srcDirectValues.has(key)) srcDirectValues.set(key, new Set());
    const set = srcDirectValues.get(key)!;
    for (const row of src[table] as unknown as Record<string, string>[]) {
      const v = row[field];
      if (v && v.length >= 4) set.add(v);
    }
  };
  collect('events', 'caller_phone');
  collect('events', 'address_text');

  const scanRow = (table: string, rowId: string, field: string, value: string) => {
    if (!value) return;
    if (RE_PHONE.test(value)) hits.push({ table, rowId, field, value, reason: '匹配真实手机号模式' });
    if (RE_IDCARD.test(value)) hits.push({ table, rowId, field, value, reason: '匹配身份证号模式' });
    if (RE_EMAIL.test(value)) hits.push({ table, rowId, field, value, reason: '匹配邮箱模式' });
    if (RE_BANK.test(value.replace(/SYN-PH-/g, ''))) hits.push({ table, rowId, field, value, reason: '匹配银行卡号模式' });
    for (const [key, set] of srcDirectValues) {
      if (set.has(value)) hits.push({ table, rowId, field, value, reason: `与源字段 ${key} 逐字相同` });
    }
  };

  for (const table of Object.keys(exportFields) as (keyof TableRows)[]) {
    const fields = exportFields[table] ?? [];
    for (const row of syn[table] as unknown as Record<string, string>[]) {
      const rowId = row[`${table.slice(0, -1)}_id`] ?? row.event_id ?? row.dispatch_id ?? row.resource_id ?? row.arrival_id ?? row.closure_id ?? '?';
      for (const f of fields) scanRow(table, rowId, f, row[f] ?? '');
    }
  }
  return hits;
}

// ---------- 近乎复制检测 ----------

export interface NearCopyHit {
  syntheticEventId: string;
  sourceEventId: string;
  similarity: number;
}

interface EventFinger {
  id: string;
  type: string;
  district: string;
  priority: string;
  pattern: string;
  outcome: string;
  alarmMs: number;
  response: number | null;
  travelAvg: number | null;
  onScene: number | null;
}

function fingerprint(rows: TableRows): EventFinger[] {
  const chains = buildChains(rows);
  return chains.map((c) => {
    const travels = c.legs.filter((l) => l.arriveMs != null).map((l) => (l.arriveMs! - l.dispatchMs) / 60000);
    return {
      id: c.eventId,
      type: c.event_type,
      district: c.district,
      priority: c.priority,
      pattern: c.pattern,
      outcome: c.outcome || '未知',
      alarmMs: c.alarmMs,
      response: c.legs.length ? (c.legs[0].dispatchMs - c.alarmMs) / 60000 : null,
      travelAvg: travels.length ? travels.reduce((a, b) => a + b, 0) / travels.length : null,
      onScene: c.closeMs != null && c.legs.length ? (c.closeMs - Math.max(...c.legs.map((l) => l.arriveMs ?? l.dispatchMs))) / 60000 : null
    };
  });
}

function simNum(a: number | null, b: number | null, relTol: number): number {
  if (a == null || b == null) return 0;
  const denom = Math.max(Math.abs(a), Math.abs(b), 1);
  const d = Math.abs(a - b) / denom;
  return d <= relTol ? 1 : Math.max(0, 1 - (d - relTol) * 2);
}

/** 加权相似度：类别字段 + 报警时刻窗 + 时长容差 */
export function similarity(a: EventFinger, b: EventFinger): number {
  let s = 0;
  if (a.type === b.type) s += 0.20;
  if (a.district === b.district) s += 0.12;
  if (a.priority === b.priority) s += 0.08;
  if (a.pattern === b.pattern) s += 0.10;
  if (a.outcome === b.outcome) s += 0.10;
  const dtMin = Math.abs(a.alarmMs - b.alarmMs) / 60000;
  if (dtMin <= 60) s += 0.15 * (1 - dtMin / 60);
  s += 0.10 * simNum(a.response, b.response, 0.2);
  s += 0.10 * simNum(a.travelAvg, b.travelAvg, 0.2);
  s += 0.05 * simNum(a.onScene, b.onScene, 0.2);
  return s;
}

export function detectNearCopies(syn: TableRows, src: TableRows, warnAt: number, failAt: number): { warn: NearCopyHit[]; fail: NearCopyHit[]; maxSim: number } {
  const synF = fingerprint(syn);
  const srcF = fingerprint(src);
  const warn: NearCopyHit[] = [];
  const fail: NearCopyHit[] = [];
  let maxSim = 0;
  for (const s of synF) {
    let best: { id: string; sim: number } | null = null;
    for (const r of srcF) {
      // 快速剪枝：类型不同且时刻差>2h 的不可能超过阈值
      if (s.type !== r.type && Math.abs(s.alarmMs - r.alarmMs) > 2 * 3600_000) continue;
      const sim = similarity(s, r);
      if (!best || sim > best.sim) best = { id: r.id, sim };
    }
    if (best) {
      maxSim = Math.max(maxSim, best.sim);
      if (best.sim >= failAt) fail.push({ syntheticEventId: s.id, sourceEventId: best.id, similarity: Math.round(best.sim * 1000) / 1000 });
      else if (best.sim >= warnAt) warn.push({ syntheticEventId: s.id, sourceEventId: best.id, similarity: Math.round(best.sim * 1000) / 1000 });
    }
  }
  return { warn, fail, maxSim };
}

// ---------- 已声明字段组合的独特性 ----------

export interface ComboRisk {
  combo: string[];
  key: string;
  count: number;
}

/** 对声明的字段组合计算 k-匿名式计数，列出 count < k 的组合 */
export function checkUniqueCombos(syn: TableRows, combos: string[][], k: number): ComboRisk[] {
  const chains = buildChains(syn);
  const view = chains.map((c) => ({
    event_type: c.event_type,
    district: c.district,
    priority: c.priority,
    chain_pattern: c.pattern,
    outcome: c.outcome || '未知',
    alarm_hour: String(new Date(c.alarmMs).getHours())
  }));
  const risks: ComboRisk[] = [];
  for (const combo of combos) {
    const counts = new Map<string, number>();
    for (const row of view) {
      const key = combo.map((f) => (row as Record<string, string>)[f] ?? '?').join(' | ');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts) {
      if (count < k) risks.push({ combo, key, count });
    }
  }
  return risks.sort((a, b) => a.count - b.count);
}

export const COMBO_FIELD_LABELS: Record<string, string> = {
  event_type: '事件类型',
  district: '行政区',
  priority: '优先级',
  chain_pattern: '链型',
  outcome: '结局',
  alarm_hour: '报警小时'
};

export { parseTs };

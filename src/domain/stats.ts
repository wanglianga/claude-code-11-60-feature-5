// 统计学习：从来源批次行计算方案分布（事件类型、时长直方图、链型等）。
// 同时提供“事件链”组装视图，供生成器、核验器共用。

import type { Hist, PlanDistributions, TableRows } from './types';
import { parseTs, minutesBetween } from './time';

export interface ChainEvent {
  eventId: string;
  event_type: string;
  district: string;
  priority: string;
  alarmMs: number;
  outcome: string;
  closeMs: number | null;
  pattern: ChainPattern;
  legs: ChainLeg[]; // 按派遣时间排序
}
export interface ChainLeg {
  resourceId: string;
  dispatchMs: number;
  arriveMs: number | null;
}
export type ChainPattern = 'single' | 'concurrent2' | 'concurrent3' | 'transfer2' | 'transfer3';

export const PATTERNS: ChainPattern[] = ['single', 'concurrent2', 'concurrent3', 'transfer2', 'transfer3'];
export const PATTERN_LABELS: Record<ChainPattern, string> = {
  single: '单车处置',
  concurrent2: '并发派车×2',
  concurrent3: '并发派车×3',
  transfer2: '二级转运',
  transfer3: '三级转运'
};

export function patternOf(nLegs: number, isTransfer: boolean): ChainPattern {
  if (nLegs <= 1) return 'single';
  if (isTransfer) return nLegs >= 3 ? 'transfer3' : 'transfer2';
  return nLegs >= 3 ? 'concurrent3' : 'concurrent2';
}

/**
 * 把多表行组装为事件链视图。
 * 转运判定：同一事件的多个派遣，若后一程派遣时间 >= 前一程到场时间，则为转运链；否则为并发派车。
 */
export function buildChains(rows: TableRows): ChainEvent[] {
  const dispByEvent = new Map<string, typeof rows.dispatches>();
  for (const d of rows.dispatches) {
    const arr = dispByEvent.get(d.event_id) ?? [];
    arr.push(d);
    dispByEvent.set(d.event_id, arr);
  }
  const arrByDispatch = new Map(rows.arrivals.map((a) => [a.dispatch_id, a]));
  const closeByEvent = new Map(rows.closures.map((c) => [c.event_id, c]));
  const out: ChainEvent[] = [];
  for (const e of rows.events) {
    const disps = (dispByEvent.get(e.event_id) ?? [])
      .slice()
      .sort((a, b) => parseTs(a.dispatch_time) - parseTs(b.dispatch_time));
    const legs: ChainLeg[] = disps.map((d) => {
      const arr = arrByDispatch.get(d.dispatch_id);
      return {
        resourceId: d.resource_id,
        dispatchMs: parseTs(d.dispatch_time),
        arriveMs: arr ? parseTs(arr.arrive_time) : null
      };
    });
    let isTransfer = false;
    for (let i = 1; i < legs.length; i++) {
      const prev = legs[i - 1];
      if (prev.arriveMs != null && legs[i].dispatchMs >= prev.arriveMs) isTransfer = true;
    }
    const closure = closeByEvent.get(e.event_id);
    out.push({
      eventId: e.event_id,
      event_type: e.event_type,
      district: e.district,
      priority: e.priority,
      alarmMs: parseTs(e.alarm_time),
      outcome: closure?.outcome ?? '',
      closeMs: closure ? parseTs(closure.close_time) : null,
      pattern: patternOf(legs.length, isTransfer),
      legs
    });
  }
  return out;
}

export function makeHist(values: number[], edges: number[]): Hist {
  const counts = new Array(edges.length - 1).fill(0);
  for (const v of values) {
    let idx = edges.length - 2;
    for (let i = 0; i < edges.length - 1; i++) {
      if (v >= edges[i] && v < edges[i + 1]) { idx = i; break; }
    }
    counts[idx]++;
  }
  return { edges, counts };
}

function mixOf(values: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const v of values) m[v] = (m[v] ?? 0) + 1;
  const total = values.length || 1;
  for (const k of Object.keys(m)) m[k] = m[k] / total;
  return m;
}

function mixBy(keys: string[], values: string[]): Record<string, Record<string, number>> {
  const groups = new Map<string, string[]>();
  for (let i = 0; i < keys.length; i++) {
    const arr = groups.get(keys[i]) ?? [];
    arr.push(values[i]);
    groups.set(keys[i], arr);
  }
  const out: Record<string, Record<string, number>> = {};
  for (const [k, arr] of groups) out[k] = mixOf(arr);
  return out;
}

export const DEFAULT_EDGES = {
  response: [0, 1, 2, 3, 5, 8, 12, 20, 30],
  travel: [0, 3, 6, 10, 15, 22, 32, 45, 60, 90],
  onScene: [0, 5, 10, 20, 35, 55, 90, 150, 240],
  total: [0, 20, 40, 60, 90, 130, 200, 300, 480]
};

/** 从来源表学习方案分布（仅使用完整链路的时长） */
export function learnDistributions(rows: TableRows): PlanDistributions {
  const chains = buildChains(rows);
  const events = rows.events;
  const hourly = new Array(24).fill(0);
  const responseV: number[] = [];
  const travelV: number[] = [];
  const onSceneV: number[] = [];
  const totalV: number[] = [];
  for (const c of chains) {
    hourly[new Date(c.alarmMs).getHours()]++;
    if (c.legs.length > 0) {
      const r = minutesBetween(c.alarmMs, c.legs[0].dispatchMs);
      if (r >= 0) responseV.push(r);
    }
    for (const leg of c.legs) {
      if (leg.arriveMs != null) {
        const t = minutesBetween(leg.dispatchMs, leg.arriveMs);
        if (t >= 0) travelV.push(t);
      }
    }
    if (c.closeMs != null && c.legs.length > 0) {
      const lastArrive = Math.max(...c.legs.map((l) => l.arriveMs ?? l.dispatchMs));
      const os = minutesBetween(lastArrive, c.closeMs);
      if (os >= 0) onSceneV.push(os);
      const tot = minutesBetween(c.alarmMs, c.closeMs);
      if (tot >= 0) totalV.push(tot);
    }
  }
  const hourlyTotal = hourly.reduce((a, b) => a + b, 0) || 1;
  return {
    eventTypeMix: mixOf(events.map((e) => e.event_type)),
    districtMix: mixOf(events.map((e) => e.district)),
    priorityMixByType: mixBy(events.map((e) => e.event_type), events.map((e) => e.priority)),
    hourlyMix: hourly.map((h) => h / hourlyTotal),
    chainPatternMixByType: mixBy(chains.map((c) => c.event_type), chains.map((c) => c.pattern)),
    outcomeMixByType: mixBy(chains.map((c) => c.event_type), chains.map((c) => c.outcome || '未知')),
    durationHists: {
      response: makeHist(responseV, DEFAULT_EDGES.response),
      travel: makeHist(travelV, DEFAULT_EDGES.travel),
      onScene: makeHist(onSceneV, DEFAULT_EDGES.onScene),
      total: makeHist(totalV, DEFAULT_EDGES.total)
    }
  };
}

/** 联合分布表（分布学习+筛选路线使用）：(类型|区域|优先级|链型|结局) -> 计数，加一平滑 */
export interface JointModel {
  combos: { key: string; type: string; district: string; priority: string; pattern: ChainPattern; outcome: string; count: number }[];
  responseHistByType: Record<string, Hist>;
  travelHistByType: Record<string, Hist>;
  onSceneHistByType: Record<string, Hist>;
  hourlyMix: number[];
}

export function learnJoint(rows: TableRows): JointModel {
  const chains = buildChains(rows);
  const map = new Map<string, { type: string; district: string; priority: string; pattern: ChainPattern; outcome: string; count: number }>();
  const respByType = new Map<string, number[]>();
  const travByType = new Map<string, number[]>();
  const osByType = new Map<string, number[]>();
  const pushTo = (m: Map<string, number[]>, k: string, v: number) => {
    const arr = m.get(k) ?? [];
    arr.push(v);
    m.set(k, arr);
  };
  const hourly = new Array(24).fill(0);
  for (const c of chains) {
    const key = [c.event_type, c.district, c.priority, c.pattern, c.outcome || '未知'].join('|');
    const cur = map.get(key) ?? { type: c.event_type, district: c.district, priority: c.priority, pattern: c.pattern, outcome: c.outcome || '未知', count: 0 };
    cur.count++;
    map.set(key, cur);
    hourly[new Date(c.alarmMs).getHours()]++;
    if (c.legs.length > 0) {
      const r = minutesBetween(c.alarmMs, c.legs[0].dispatchMs);
      if (r >= 0) pushTo(respByType, c.event_type, r);
    }
    for (const leg of c.legs) {
      if (leg.arriveMs != null) {
        const t = minutesBetween(leg.dispatchMs, leg.arriveMs);
        if (t >= 0) pushTo(travByType, c.event_type, t);
      }
    }
    if (c.closeMs != null && c.legs.length > 0) {
      const lastArrive = Math.max(...c.legs.map((l) => l.arriveMs ?? l.dispatchMs));
      const os = minutesBetween(lastArrive, c.closeMs);
      if (os >= 0) pushTo(osByType, c.event_type, os);
    }
  }
  // 加一平滑：让稀有组合保留非零概率
  const combos = [...map.entries()].map(([key, c]) => ({ key, ...c, count: c.count + 1 }));
  const toHist = (m: Map<string, number[]>, edges: number[]) => {
    const out: Record<string, Hist> = {};
    for (const [k, v] of m) out[k] = makeHist(v, edges);
    return out;
  };
  const hourlyTotal = hourly.reduce((a, b) => a + b, 0) || 1;
  return {
    combos,
    responseHistByType: toHist(respByType, DEFAULT_EDGES.response),
    travelHistByType: toHist(travByType, DEFAULT_EDGES.travel),
    onSceneHistByType: toHist(osByType, DEFAULT_EDGES.onScene),
    hourlyMix: hourly.map((h) => h / hourlyTotal)
  };
}

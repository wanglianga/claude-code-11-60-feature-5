// 关系规则：引用完整性、先后约束、资源占用、时间可行性。
// 生成器（两条路线）与质量核验器共用本模块，保证“满足同一关系规则、通过相同核验”。
// 所有时间比较一律基于绝对毫秒，跨午夜区间不会被误判为日期倒序。

import type { RuleSet, TableRows } from './types';
import { parseTs, intervalsOverlap } from './time';
import { buildChains, type ChainEvent } from './stats';

export interface Violation {
  kind: string;
  message: string;
  ref?: string;
}

/** 引用完整性：每个外键都必须能在目标表找到 */
export function checkReferential(rows: TableRows): Violation[] {
  const v: Violation[] = [];
  const eventIds = new Set(rows.events.map((e) => e.event_id));
  const dispatchIds = new Set(rows.dispatches.map((d) => d.dispatch_id));
  const resourceIds = new Set(rows.resources.map((r) => r.resource_id));
  for (const d of rows.dispatches) {
    if (!eventIds.has(d.event_id)) v.push({ kind: 'ref', message: `派遣 ${d.dispatch_id} 引用了不存在的事件 ${d.event_id}`, ref: d.dispatch_id });
    if (!resourceIds.has(d.resource_id)) v.push({ kind: 'ref', message: `派遣 ${d.dispatch_id} 引用了不存在的资源 ${d.resource_id}`, ref: d.dispatch_id });
  }
  for (const a of rows.arrivals) {
    if (!dispatchIds.has(a.dispatch_id)) v.push({ kind: 'ref', message: `到场 ${a.arrival_id} 引用了不存在的派遣 ${a.dispatch_id}`, ref: a.arrival_id });
  }
  for (const c of rows.closures) {
    if (!eventIds.has(c.event_id)) v.push({ kind: 'ref', message: `结案 ${c.closure_id} 引用了不存在的事件 ${c.event_id}`, ref: c.closure_id });
  }
  // 每个派遣至多一条到场；每个事件至多一条结案
  const arrCount = new Map<string, number>();
  for (const a of rows.arrivals) arrCount.set(a.dispatch_id, (arrCount.get(a.dispatch_id) ?? 0) + 1);
  for (const [k, n] of arrCount) if (n > 1) v.push({ kind: 'ref', message: `派遣 ${k} 存在 ${n} 条到场记录（应至多 1 条）`, ref: k });
  const closeCount = new Map<string, number>();
  for (const c of rows.closures) closeCount.set(c.event_id, (closeCount.get(c.event_id) ?? 0) + 1);
  for (const [k, n] of closeCount) if (n > 1) v.push({ kind: 'ref', message: `事件 ${k} 存在 ${n} 条结案记录（应至多 1 条）`, ref: k });
  // 覆盖性：每个事件至少一条派遣、一条结案；每条派遣应有到场
  for (const e of rows.events) {
    if (!rows.dispatches.some((d) => d.event_id === e.event_id)) v.push({ kind: 'coverage', message: `事件 ${e.event_id} 缺少派遣记录`, ref: e.event_id });
    if (!closeCount.has(e.event_id)) v.push({ kind: 'coverage', message: `事件 ${e.event_id} 缺少结案记录`, ref: e.event_id });
  }
  for (const d of rows.dispatches) {
    if (!arrCount.has(d.dispatch_id)) v.push({ kind: 'coverage', message: `派遣 ${d.dispatch_id} 缺少到场记录`, ref: d.dispatch_id });
  }
  return v;
}

/** 链级先后约束与时长边界 */
export function checkChainTiming(rows: TableRows, ruleSet: RuleSet): Violation[] {
  const v: Violation[] = [];
  const b = ruleSet.bounds;
  const chains = buildChains(rows);
  for (const c of chains) {
    for (let i = 0; i < c.legs.length; i++) {
      const leg = c.legs[i];
      const respMin = (leg.dispatchMs - c.alarmMs) / 60000;
      if (leg.dispatchMs < c.alarmMs) {
        v.push({ kind: 'order', message: `事件 ${c.eventId} 第 ${i + 1} 程派遣早于报警时间`, ref: c.eventId });
      } else if (i === 0 && respMin > b.responseMaxMin) {
        v.push({ kind: 'bound', message: `事件 ${c.eventId} 响应耗时 ${respMin.toFixed(1)} 分钟，超过上限 ${b.responseMaxMin}`, ref: c.eventId });
      }
      if (leg.arriveMs != null) {
        if (leg.arriveMs < leg.dispatchMs) {
          v.push({ kind: 'order', message: `事件 ${c.eventId} 第 ${i + 1} 程到场早于派遣（不可能的处置顺序）`, ref: c.eventId });
        } else {
          const travelMin = (leg.arriveMs - leg.dispatchMs) / 60000;
          if (travelMin > b.travelMaxMin) v.push({ kind: 'bound', message: `事件 ${c.eventId} 第 ${i + 1} 程行驶 ${travelMin.toFixed(1)} 分钟，超过上限 ${b.travelMaxMin}`, ref: c.eventId });
        }
      }
      // 转运链：下一程派遣不得早于上一程到场 + 最小交接间隔
      if (i > 0) {
        const prev = c.legs[i - 1];
        if (prev.arriveMs != null && leg.dispatchMs >= prev.arriveMs) {
          const gap = (leg.dispatchMs - prev.arriveMs) / 60000;
          if (gap < b.transferGapMin) v.push({ kind: 'order', message: `事件 ${c.eventId} 转运交接间隔 ${gap.toFixed(1)} 分钟，小于最小值 ${b.transferGapMin}`, ref: c.eventId });
        }
      }
    }
    if (c.closeMs != null) {
      const lastArrive = c.legs.length ? Math.max(...c.legs.map((l) => l.arriveMs ?? l.dispatchMs)) : c.alarmMs;
      if (c.closeMs < lastArrive) v.push({ kind: 'order', message: `事件 ${c.eventId} 结案早于末次到场（不可能的处置顺序）`, ref: c.eventId });
      const onScene = (c.closeMs - lastArrive) / 60000;
      if (onScene > b.onSceneMaxMin) v.push({ kind: 'bound', message: `事件 ${c.eventId} 现场处置 ${onScene.toFixed(1)} 分钟，超过上限 ${b.onSceneMaxMin}`, ref: c.eventId });
      const total = (c.closeMs - c.alarmMs) / 60000;
      if (total > b.totalMaxMin) v.push({ kind: 'bound', message: `事件 ${c.eventId} 全程 ${total.toFixed(1)} 分钟，超过上限 ${b.totalMaxMin}`, ref: c.eventId });
    }
  }
  return v;
}

/**
 * 资源占用核验：同一车辆的占用区间（派遣时刻 -> 到场+周转）不得重叠。
 * 基于绝对毫秒比较，跨午夜任务区间（23:50 -> 次日 00:20）视为正常，不算日期倒序。
 */
export function checkResourceOccupancy(rows: TableRows, ruleSet: RuleSet): Violation[] {
  const v: Violation[] = [];
  const turnoverMs = ruleSet.bounds.turnoverMin * 60000;
  const byRes = new Map<string, { start: number; end: number; dispatchId: string }[]>();
  const arrByDispatch = new Map(rows.arrivals.map((a) => [a.dispatch_id, a]));
  for (const d of rows.dispatches) {
    const start = parseTs(d.dispatch_time);
    const arr = arrByDispatch.get(d.dispatch_id);
    const end = (arr ? parseTs(arr.arrive_time) : start) + turnoverMs;
    const list = byRes.get(d.resource_id) ?? [];
    list.push({ start, end, dispatchId: d.dispatch_id });
    byRes.set(d.resource_id, list);
  }
  for (const [res, list] of byRes) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (intervalsOverlap(prev.start, prev.end, cur.start, cur.end)) {
        v.push({
          kind: 'occupancy',
          message: `资源 ${res} 任务区间重叠：${prev.dispatchId} 与 ${cur.dispatchId}`,
          ref: res
        });
      }
    }
  }
  return v;
}

/** 能力匹配：事件类型所需能力必须被派遣资源覆盖 */
export function checkCapability(rows: TableRows, ruleSet: RuleSet): Violation[] {
  const v: Violation[] = [];
  const resById = new Map(rows.resources.map((r) => [r.resource_id, r]));
  const eventById = new Map(rows.events.map((e) => [e.event_id, e]));
  for (const d of rows.dispatches) {
    const ev = eventById.get(d.event_id);
    const res = resById.get(d.resource_id);
    if (!ev || !res) continue;
    const need = ruleSet.capabilityMap[ev.event_type] ?? [];
    const caps = res.capability.split(/[,，]/).map((s) => s.trim());
    for (const n of need) {
      if (!caps.includes(n)) {
        v.push({ kind: 'capability', message: `资源 ${res.resource_id}（${res.resource_type}）不具备事件 ${ev.event_id}（${ev.event_type}）所需能力「${n}」`, ref: d.dispatch_id });
      }
    }
  }
  return v;
}

export function checkAll(rows: TableRows, ruleSet: RuleSet): Violation[] {
  return [
    ...checkReferential(rows),
    ...checkChainTiming(rows, ruleSet),
    ...checkResourceOccupancy(rows, ruleSet),
    ...checkCapability(rows, ruleSet)
  ];
}

/** 资源池可用性查询（生成器用）：在 [start, end) 区间内不与既有占用冲突的资源 */
export class ResourcePool {
  private busy = new Map<string, { start: number; end: number }[]>();
  constructor(private turnoverMin: number) {}

  isFree(resourceId: string, start: number, end: number): boolean {
    const list = this.busy.get(resourceId) ?? [];
    return !list.some((iv) => intervalsOverlap(iv.start, iv.end, start, end));
  }

  occupy(resourceId: string, start: number, end: number): void {
    const list = this.busy.get(resourceId) ?? [];
    list.push({ start, end });
    this.busy.set(resourceId, list);
  }

  /** 找到某资源在 notBefore 之后、能容纳 [t, t+len) 的最早起点 */
  earliestFree(resourceId: string, notBefore: number, lenMs: number): number {
    const list = (this.busy.get(resourceId) ?? []).slice().sort((a, b) => a.start - b.start);
    let t = notBefore;
    for (const iv of list) {
      if (t + lenMs <= iv.start) break;
      if (t < iv.end) t = iv.end;
    }
    return t;
  }
}

export function occupancyEnd(arriveMs: number, turnoverMin: number): number {
  return arriveMs + turnoverMin * 60000;
}

export type { ChainEvent };

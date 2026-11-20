// 路线 B：从样本学习联合分布 -> 批量抽样 -> 用同一组关系约束筛选。
// 相关性保留较好、批量效率高；稀有模式因样本少可能失真，筛选率变化影响产量（在统计中如实报告）。

import type { GenPayload, GenResult, SourceArrival, SourceClosure, SourceDispatch, SourceEvent, TableRows } from './types';
import { mulberry32, randInt, weighted, sampleHist, gaussian, type Rng } from './prng';
import { fmtTs, MIN } from './time';
import { ResourcePool } from './constraints';
import { learnJoint, type ChainPattern } from './stats';
import { buildResourcePool, synthAddress, synthPhone } from './genShared';

const PATTERN_LEGS: Record<ChainPattern, number> = { single: 1, concurrent2: 2, concurrent3: 3, transfer2: 2, transfer3: 3 };

interface Candidate {
  alarmMs: number;
  type: string; district: string; priority: string; pattern: ChainPattern; outcome: string;
  legs: { dispatchMs: number; travelMin: number }[];
  closeMs: number;
}

export function generateJointFilter(payload: GenPayload, onProgress?: (done: number, total: number) => void): GenResult {
  const { plan, ruleSet, source } = payload;
  const rng: Rng = mulberry32(plan.seed);
  const b = ruleSet.bounds;
  const model = learnJoint(source);
  const resources = buildResourcePool(plan.resourcePool, rng, String(plan.seed % 1000));
  const pool = new ResourcePool(b.turnoverMin);
  const startMs = new Date(plan.dateRange.start.replace(' ', 'T')).getTime();

  const events: SourceEvent[] = [];
  const dispatches: SourceDispatch[] = [];
  const arrivals: SourceArrival[] = [];
  const closures: SourceClosure[] = [];
  let tried = 0;
  let phoneSeq = 0;
  const t0 = Date.now();

  const accepted: (Candidate & { resIds: string[] })[] = [];
  const maxRounds = 4;
  for (let round = 0; round < maxRounds && accepted.length < plan.targetEvents; round++) {
    const remaining = plan.targetEvents - accepted.length;
    // 过量抽样补偿筛选损耗；随轮次提高过量系数
    const M = Math.ceil(remaining * (1.6 + round * 0.5));
    const cands: Candidate[] = [];
    for (let i = 0; i < M; i++) {
      tried++;
      const combo = weighted(rng, model.combos, model.combos.map((c) => c.count));
      // 报警时刻：天均匀 + 小时分布
      const day = randInt(rng, 0, plan.dateRange.days - 1);
      let r = rng();
      let hour = 23;
      for (let h = 0; h < 24; h++) { r -= model.hourlyMix[h] ?? 0; if (r <= 0) { hour = h; break; } }
      const alarmMs = startMs + day * 24 * 60 * MIN + hour * 60 * MIN + randInt(rng, 0, 3599) * 1000;
      // 时长：按事件类型的条件直方图（缺失时退回方案全局直方图）
      const respH = model.responseHistByType[combo.type] ?? plan.distributions.durationHists.response;
      const travH = model.travelHistByType[combo.type] ?? plan.distributions.durationHists.travel;
      const osH = model.onSceneHistByType[combo.type] ?? plan.distributions.durationHists.onScene;
      const nLegs = PATTERN_LEGS[combo.pattern] ?? 1;
      const isTransfer = combo.pattern.startsWith('transfer');
      const legs: Candidate['legs'] = [];
      let prevArrive: number | null = null;
      let feasible = true;
      for (let leg = 0; leg < nLegs; leg++) {
        const travelMin = Math.max(1, sampleHist(rng, travH));
        let dispatchMs: number;
        if (leg === 0) {
          const response = Math.max(0.2, sampleHist(rng, respH));
          dispatchMs = alarmMs + response * MIN;
        } else if (isTransfer && prevArrive != null) {
          dispatchMs = prevArrive + (b.transferGapMin + Math.max(0, gaussian(rng, 8, 4))) * MIN;
        } else {
          dispatchMs = legs[0].dispatchMs + randInt(rng, 0, 3) * MIN;
        }
        legs.push({ dispatchMs, travelMin });
        prevArrive = dispatchMs + travelMin * MIN;
      }
      const lastArrive = Math.max(...legs.map((l) => l.dispatchMs + l.travelMin * MIN));
      const onScene = Math.max(1, sampleHist(rng, osH));
      const closeMs = lastArrive + onScene * MIN;
      // 筛选阶段 1：纯约束（时长边界 / 先后可行性）
      const respMin = (legs[0].dispatchMs - alarmMs) / MIN;
      if (respMin > b.responseMaxMin) feasible = false;
      if (legs.some((l) => l.travelMin > b.travelMaxMin)) feasible = false;
      if ((closeMs - lastArrive) / MIN > b.onSceneMaxMin) feasible = false;
      if ((closeMs - alarmMs) / MIN > b.totalMaxMin) feasible = false;
      if (!feasible) continue;
      cands.push({ alarmMs, type: combo.type, district: combo.district, priority: combo.priority, pattern: combo.pattern, outcome: combo.outcome, legs, closeMs });
    }
    // 筛选阶段 2：按时间序做资源指派，不可指派者拒绝
    cands.sort((a, b2) => a.alarmMs - b2.alarmMs);
    for (const c of cands) {
      if (accepted.length >= plan.targetEvents) break;
      const need = ruleSet.capabilityMap[c.type] ?? [];
      const capable = resources.filter((res) => need.every((n) => res.capability.split(',').includes(n)));
      const resIds: string[] = [];
      let ok = true;
      for (const leg of c.legs) {
        const s = leg.dispatchMs;
        const e = leg.dispatchMs + leg.travelMin * MIN + b.turnoverMin * MIN;
        const free = capable.filter((res) => !resIds.includes(res.resource_id) && pool.isFree(res.resource_id, s, e));
        if (free.length === 0) { ok = false; break; }
        const chosen = free[Math.floor(rng() * free.length)];
        resIds.push(chosen.resource_id);
        pool.occupy(chosen.resource_id, s, e);
      }
      if (!ok) continue;
      accepted.push({ ...c, resIds });
    }
    if (onProgress) onProgress(Math.min(accepted.length, plan.targetEvents), plan.targetEvents);
  }

  // 赋全新标识并落行
  accepted.sort((a, b2) => a.alarmMs - b2.alarmMs);
  accepted.forEach((c, idx) => {
    const eid = `EVT-S${plan.seed % 10000}-${String(idx + 1).padStart(4, '0')}`;
    phoneSeq++;
    events.push({
      event_id: eid,
      alarm_time: fmtTs(c.alarmMs),
      event_type: c.type,
      district: c.district,
      address_text: synthAddress(rng, c.district),
      caller_phone: synthPhone(phoneSeq),
      priority: c.priority
    });
    const isTransfer = c.pattern.startsWith('transfer');
    c.legs.forEach((leg, li) => {
      const did = `DSP-S${plan.seed % 10000}-${String(idx + 1).padStart(4, '0')}-${li + 1}`;
      dispatches.push({ dispatch_id: did, event_id: eid, resource_id: c.resIds[li], dispatch_time: fmtTs(leg.dispatchMs) });
      arrivals.push({
        arrival_id: `ARR-S${plan.seed % 10000}-${String(idx + 1).padStart(4, '0')}-${li + 1}`,
        dispatch_id: did,
        arrive_time: fmtTs(leg.dispatchMs + leg.travelMin * MIN),
        arrive_site: isTransfer && li > 0 ? '医院' : '现场'
      });
    });
    closures.push({
      closure_id: `CLS-S${plan.seed % 10000}-${String(idx + 1).padStart(4, '0')}`,
      event_id: eid,
      close_time: fmtTs(c.closeMs),
      outcome: c.outcome
    });
  });

  const tables: TableRows = { events, dispatches, resources, arrivals, closures };
  const durationMs = Date.now() - t0;
  const acceptedN = events.length;
  return {
    tables,
    stats: {
      events: acceptedN,
      dispatches: dispatches.length,
      arrivals: arrivals.length,
      closures: closures.length,
      resources: resources.length,
      candidates: tried,
      filterRate: tried > 0 ? Math.round((1 - acceptedN / tried) * 1000) / 1000 : 0,
      throughputPerSec: durationMs > 0 ? Math.round((acceptedN / durationMs) * 1000) : acceptedN
    }
  };
}

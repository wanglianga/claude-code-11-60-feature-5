// 路线 A：约束驱动的条件采样。
// 逐步生成事件链（先链结构、再填属性），资源可用性在生成时即按占用区间保证，
// 因此产出天然满足关系规则；稀少组合按方案分布精确采样，吞吐相对较低。

import type { GenPayload, GenResult, SourceDispatch, SourceEvent, SourceArrival, SourceClosure, TableRows } from './types';
import { mulberry32, sampleMix, sampleHist, randInt, gaussian, type Rng } from './prng';
import { fmtTs, MIN } from './time';
import { ResourcePool } from './constraints';
import { buildResourcePool, synthAddress, synthPhone } from './genShared';
import type { ChainPattern } from './stats';

const PATTERN_LEGS: Record<ChainPattern, number> = { single: 1, concurrent2: 2, concurrent3: 3, transfer2: 2, transfer3: 3 };

interface AlarmSlot { alarmMs: number; }

function sampleAlarmTimes(rng: Rng, count: number, start: string, days: number, hourlyMix: number[]): AlarmSlot[] {
  const startMs = new Date(start.replace(' ', 'T')).getTime();
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const slots: AlarmSlot[] = [];
  for (let i = 0; i < count; i++) {
    const day = randInt(rng, 0, days - 1);
    // 按小时分布抽小时
    let r = rng();
    let hour = 23;
    for (const h of hours) { r -= hourlyMix[h] ?? 0; if (r <= 0) { hour = h; break; } }
    const alarmMs = startMs + day * 24 * 60 * MIN + hour * 60 * MIN + randInt(rng, 0, 59) * MIN + randInt(rng, 0, 59) * 1000;
    slots.push({ alarmMs });
  }
  slots.sort((a, b) => a.alarmMs - b.alarmMs);
  return slots;
}

export function generateConstraint(payload: GenPayload, onProgress?: (done: number, total: number) => void): GenResult {
  const { plan, ruleSet } = payload;
  const rng: Rng = mulberry32(plan.seed);
  const b = ruleSet.bounds;
  const dist = plan.distributions;
  const resources = buildResourcePool(plan.resourcePool, rng, String(plan.seed % 1000));
  const pool = new ResourcePool(b.turnoverMin);
  const capableOf = (type: string) => {
    const need = ruleSet.capabilityMap[type] ?? [];
    return resources.filter((r) => {
      const caps = r.capability.split(',');
      return need.every((n) => caps.includes(n));
    });
  };

  const events: SourceEvent[] = [];
  const dispatches: SourceDispatch[] = [];
  const arrivals: SourceArrival[] = [];
  const closures: SourceClosure[] = [];
  let dropped = 0;
  let phoneSeq = 0;

  const slots = sampleAlarmTimes(rng, plan.targetEvents, plan.dateRange.start, plan.dateRange.days, dist.hourlyMix);
  const t0 = Date.now();

  for (let idx = 0; idx < slots.length; idx++) {
    let placed = false;
    let alarmMs = slots[idx].alarmMs;
    // 属性采样（每个事件一次；重试仅调整时刻，不改变属性，保证分布精确）
    const type = sampleMix(rng, dist.eventTypeMix);
    const district = sampleMix(rng, dist.districtMix);
    const priority = sampleMix(rng, dist.priorityMixByType[type] ?? { P2: 1 });
    const pattern = sampleMix(rng, dist.chainPatternMixByType[type] ?? { single: 1 }) as ChainPattern;
    const outcome = sampleMix(rng, dist.outcomeMixByType[type] ?? { 现场处置: 1 });
    const nLegs = PATTERN_LEGS[pattern] ?? 1;
    const isTransfer = pattern.startsWith('transfer');

    for (let attempt = 0; attempt < 6 && !placed; attempt++) {
      if (attempt > 0) alarmMs = slots[idx].alarmMs + randInt(rng, 30, 240) * MIN * attempt;
      const legs: { resId: string; dispatchMs: number; arriveMs: number }[] = [];
      let prevArrive: number | null = null;
      let ok = true;
      for (let leg = 0; leg < nLegs; leg++) {
        // 采样行驶时长
        let travel = sampleHist(rng, dist.durationHists.travel);
        travel = Math.max(1, Math.min(travel, b.travelMaxMin - 1));
        // 计算本程派遣时刻下界
        let dispatchMs: number;
        if (leg === 0) {
          let response = sampleHist(rng, dist.durationHists.response);
          response = Math.max(0.2, Math.min(response, b.responseMaxMin - 1));
          dispatchMs = alarmMs + response * MIN;
        } else if (isTransfer && prevArrive != null) {
          const gap = b.transferGapMin + Math.max(0, gaussian(rng, 8, 4));
          dispatchMs = prevArrive + gap * MIN;
        } else {
          dispatchMs = legs[0].dispatchMs + randInt(rng, 0, 3) * MIN; // 并发：近乎同时
        }
        const occStart = dispatchMs;
        const occEnd = dispatchMs + travel * MIN + b.turnoverMin * MIN;
        // 选资源：能力匹配 + 占用区间空闲
        const candidates = capableOf(type).filter((r) => pool.isFree(r.resource_id, occStart, occEnd));
        let resId: string | null = null;
        let finalDispatch = dispatchMs;
        if (candidates.length > 0) {
          resId = candidates[Math.floor(rng() * candidates.length)].resource_id;
        } else {
          // 尝试平移到最早可用时刻（仅当不破坏响应上限时接受）
          let best: { resId: string; t: number } | null = null;
          for (const r of capableOf(type)) {
            const t = pool.earliestFree(r.resource_id, occStart, travel * MIN + b.turnoverMin * MIN);
            if (!best || t < best.t) best = { resId: r.resource_id, t };
          }
          const limitOk = leg === 0
            ? best != null && (best.t - alarmMs) / MIN <= b.responseMaxMin
            : best != null && (isTransfer && prevArrive != null ? (best.t - prevArrive) / MIN <= 120 : (best.t - legs[0].dispatchMs) / MIN <= 30);
          if (best && limitOk) {
            resId = best.resId;
            finalDispatch = best.t;
          } else {
            ok = false;
            break;
          }
        }
        const arriveMs = finalDispatch + travel * MIN;
        pool.occupy(resId, finalDispatch, arriveMs + b.turnoverMin * MIN);
        legs.push({ resId, dispatchMs: finalDispatch, arriveMs });
        prevArrive = arriveMs;
      }
      if (!ok) continue;

      // 结案：末次到场 + 现场处置时长，受全程上限约束
      const lastArrive = Math.max(...legs.map((l) => l.arriveMs));
      let onScene = sampleHist(rng, dist.durationHists.onScene);
      onScene = Math.max(1, Math.min(onScene, b.onSceneMaxMin - 1));
      let closeMs = lastArrive + onScene * MIN;
      const totalMin = (closeMs - alarmMs) / MIN;
      if (totalMin > b.totalMaxMin) {
        closeMs = alarmMs + (b.totalMaxMin - randInt(rng, 5, 30)) * MIN;
        if (closeMs < lastArrive) { ok = false; }
      }
      if (!ok) continue;

      // 落库行（全新标识）
      const eid = `EVT-S${plan.seed % 10000}-${String(idx + 1).padStart(4, '0')}`;
      phoneSeq++;
      events.push({
        event_id: eid,
        alarm_time: fmtTs(alarmMs),
        event_type: type,
        district,
        address_text: synthAddress(rng, district),
        caller_phone: synthPhone(phoneSeq),
        priority
      });
      legs.forEach((leg, li) => {
        const did = `DSP-S${plan.seed % 10000}-${String(idx + 1).padStart(4, '0')}-${li + 1}`;
        dispatches.push({ dispatch_id: did, event_id: eid, resource_id: leg.resId, dispatch_time: fmtTs(leg.dispatchMs) });
        arrivals.push({
          arrival_id: `ARR-S${plan.seed % 10000}-${String(idx + 1).padStart(4, '0')}-${li + 1}`,
          dispatch_id: did,
          arrive_time: fmtTs(leg.arriveMs),
          arrive_site: isTransfer && li > 0 ? '医院' : '现场'
        });
      });
      closures.push({
        closure_id: `CLS-S${plan.seed % 10000}-${String(idx + 1).padStart(4, '0')}`,
        event_id: eid,
        close_time: fmtTs(closeMs),
        outcome
      });
      placed = true;
    }
    if (!placed) dropped++;
    if (onProgress && idx % 50 === 0) onProgress(idx, slots.length);
  }

  const tables: TableRows = { events, dispatches, resources, arrivals, closures };
  const durationMs = Date.now() - t0;
  return {
    tables,
    stats: {
      events: events.length,
      dispatches: dispatches.length,
      arrivals: arrivals.length,
      closures: closures.length,
      resources: resources.length,
      dropped,
      throughputPerSec: durationMs > 0 ? Math.round((events.length / durationMs) * 1000) : events.length
    }
  };
}

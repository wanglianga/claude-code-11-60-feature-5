import { describe, it, expect } from 'vitest';
import { checkResourceOccupancy, checkChainTiming, checkReferential, ResourcePool } from '../src/domain/constraints';
import { intervalsOverlap, parseTs } from '../src/domain/time';
import { defaultRuleSet } from '../src/domain/defaults';
import type { RuleSet, TableRows } from '../src/domain/types';

const ruleSet: RuleSet = {
  ...defaultRuleSet('2025-01-01T00:00:00Z'),
  id: 'RS-T', version: 1, status: 'approved', hash: 'x'
};

function baseRows(): TableRows {
  return {
    events: [{ event_id: 'E1', alarm_time: '2025-09-01 23:50:00', event_type: '突发疾病', district: '城东区', address_text: 'x', caller_phone: 'p', priority: 'P2' }],
    dispatches: [{ dispatch_id: 'D1', event_id: 'E1', resource_id: 'AMB-01', dispatch_time: '2025-09-01 23:52:00' }],
    resources: [{ resource_id: 'AMB-01', resource_type: '救护车', station: '城东分站', capability: '急救,转运' }],
    arrivals: [{ arrival_id: 'A1', dispatch_id: 'D1', arrive_time: '2025-09-02 00:10:00', arrive_site: '现场' }],
    closures: [{ closure_id: 'C1', event_id: 'E1', close_time: '2025-09-02 00:50:00', outcome: '送医' }]
  };
}

describe('跨午夜时间处理', () => {
  it('intervalsOverlap 基于绝对毫秒，跨午夜区间正常比较', () => {
    const s1 = parseTs('2025-09-01 23:50:00');
    const e1 = parseTs('2025-09-02 00:20:00');
    const s2 = parseTs('2025-09-02 00:05:00');
    const e2 = parseTs('2025-09-02 00:30:00');
    expect(intervalsOverlap(s1, e1, s2, e2)).toBe(true);
    const s3 = parseTs('2025-09-02 01:00:00');
    expect(intervalsOverlap(s1, e1, s3, s3 + 60000)).toBe(false);
  });

  it('跨午夜任务（23:52 派遣，次日 00:10 到场）不算日期倒序', () => {
    const rows = baseRows();
    expect(checkChainTiming(rows, ruleSet)).toEqual([]);
    expect(checkResourceOccupancy(rows, ruleSet)).toEqual([]);
  });

  it('同一车辆跨午夜区间重叠会被检出', () => {
    const rows = baseRows();
    rows.events.push({ ...rows.events[0], event_id: 'E2', alarm_time: '2025-09-01 23:55:00' });
    rows.dispatches.push({ dispatch_id: 'D2', event_id: 'E2', resource_id: 'AMB-01', dispatch_time: '2025-09-02 00:00:00' });
    rows.arrivals.push({ arrival_id: 'A2', dispatch_id: 'D2', arrive_time: '2025-09-02 00:40:00', arrive_site: '现场' });
    rows.closures.push({ closure_id: 'C2', event_id: 'E2', close_time: '2025-09-02 01:30:00', outcome: '送医' });
    const v = checkResourceOccupancy(rows, ruleSet);
    expect(v.length).toBeGreaterThan(0);
    expect(v[0].kind).toBe('occupancy');
  });

  it('到场早于派遣属于不可能的处置顺序', () => {
    const rows = baseRows();
    rows.arrivals[0].arrive_time = '2025-09-01 23:40:00';
    const v = checkChainTiming(rows, ruleSet);
    expect(v.some((x) => x.kind === 'order')).toBe(true);
  });
});

describe('引用完整性', () => {
  it('引用不存在的派遣会被检出', () => {
    const rows = baseRows();
    rows.arrivals[0].dispatch_id = 'D-NOPE';
    const v = checkReferential(rows);
    expect(v.some((x) => x.message.includes('D-NOPE'))).toBe(true);
  });
  it('缺少结案会被检出', () => {
    const rows = baseRows();
    rows.closures = [];
    const v = checkReferential(rows);
    expect(v.some((x) => x.kind === 'coverage')).toBe(true);
  });
});

describe('ResourcePool', () => {
  it('占用与最早可用时刻', () => {
    const pool = new ResourcePool(20);
    const t0 = parseTs('2025-09-01 10:00:00');
    pool.occupy('R1', t0, t0 + 30 * 60000);
    expect(pool.isFree('R1', t0 + 10 * 60000, t0 + 40 * 60000)).toBe(false);
    expect(pool.isFree('R1', t0 + 30 * 60000, t0 + 50 * 60000)).toBe(true);
    expect(pool.earliestFree('R1', t0, 10 * 60000)).toBe(t0 + 30 * 60000);
  });
});

import { describe, it, expect } from 'vitest';
import { scanDirectIdentifiers, detectNearCopies, checkUniqueCombos } from '../src/domain/privacy';
import { DEFAULT_EXPORT_FIELDS } from '../src/domain/defaults';
import type { TableRows } from '../src/domain/types';

function srcRows(): TableRows {
  return {
    events: [{
      event_id: 'E1', alarm_time: '2025-09-01 10:00:00', event_type: '突发疾病', district: '城东区',
      address_text: '城东区建设路某小区12号', caller_phone: '138****2231', priority: 'P2'
    }],
    dispatches: [{ dispatch_id: 'D1', event_id: 'E1', resource_id: 'AMB-01', dispatch_time: '2025-09-01 10:03:00' }],
    resources: [{ resource_id: 'AMB-01', resource_type: '救护车', station: '城东分站', capability: '急救,转运' }],
    arrivals: [{ arrival_id: 'A1', dispatch_id: 'D1', arrive_time: '2025-09-01 10:15:00', arrive_site: '现场' }],
    closures: [{ closure_id: 'C1', event_id: 'E1', close_time: '2025-09-01 10:50:00', outcome: '送医' }]
  };
}

function synRows(eventOverrides: Partial<TableRows['events'][0]>, closeTime = '2025-10-01 10:50:00'): TableRows {
  const e = {
    event_id: 'S1', alarm_time: '2025-10-01 10:00:00', event_type: '突发疾病', district: '城东区',
    address_text: '城东区建设路某小区12号(演练)', caller_phone: 'SYN-PH-000001', priority: 'P2',
    ...eventOverrides
  };
  return {
    events: [e],
    dispatches: [{ dispatch_id: 'SD1', event_id: 'S1', resource_id: 'AMB-S1-01', dispatch_time: '2025-10-01 10:03:00' }],
    resources: [{ resource_id: 'AMB-S1-01', resource_type: '救护车', station: '城东分站', capability: '急救,转运' }],
    arrivals: [{ arrival_id: 'SA1', dispatch_id: 'SD1', arrive_time: '2025-10-01 10:15:00', arrive_site: '现场' }],
    closures: [{ closure_id: 'SC1', event_id: 'S1', close_time: closeTime, outcome: '送医' }]
  };
}

describe('直接标识扫描', () => {
  it('合成令牌与模板地址不命中', () => {
    const hits = scanDirectIdentifiers(synRows({}), srcRows(), DEFAULT_EXPORT_FIELDS);
    expect(hits).toEqual([]);
  });
  it('真实手机号模式命中', () => {
    const hits = scanDirectIdentifiers(synRows({ caller_phone: '13812345678' }), srcRows(), DEFAULT_EXPORT_FIELDS);
    expect(hits.some((h) => h.reason.includes('手机号'))).toBe(true);
  });
  it('与源直接字段逐字相同命中', () => {
    const hits = scanDirectIdentifiers(synRows({ caller_phone: '138****2231' }), srcRows(), DEFAULT_EXPORT_FIELDS);
    expect(hits.some((h) => h.reason.includes('逐字相同'))).toBe(true);
  });
  it('身份证模式命中', () => {
    const hits = scanDirectIdentifiers(synRows({ address_text: '110101199003071234' }), srcRows(), DEFAULT_EXPORT_FIELDS);
    expect(hits.some((h) => h.reason.includes('身份证'))).toBe(true);
  });
});

describe('近乎复制检测', () => {
  it('完全照抄源记录被判为近乎复制（失败级）', () => {
    const src = srcRows();
    const syn = synRows({
      alarm_time: '2025-09-01 10:00:00',
      event_type: '突发疾病', district: '城东区', priority: 'P2'
    }, '2025-09-01 10:50:00');
    syn.dispatches[0].dispatch_time = '2025-09-01 10:03:00';
    syn.arrivals[0].arrive_time = '2025-09-01 10:15:00';
    const r = detectNearCopies(syn, src, 0.85, 0.95);
    expect(r.fail.length).toBe(1);
    expect(r.maxSim).toBeGreaterThan(0.95);
  });
  it('不同月份与属性的记录不命中', () => {
    const src = srcRows();
    const syn = synRows({ event_type: '火灾', district: '郊区', priority: 'P1' });
    const r = detectNearCopies(syn, src, 0.85, 0.95);
    expect(r.fail.length).toBe(0);
    expect(r.warn.length).toBe(0);
  });
});

describe('独特组合检查', () => {
  it('计数低于 k 的组合被列出', () => {
    const syn = synRows({});
    const risks = checkUniqueCombos(syn, [['event_type', 'district']], 3);
    expect(risks.length).toBe(1);
    expect(risks[0].count).toBe(1);
  });
});

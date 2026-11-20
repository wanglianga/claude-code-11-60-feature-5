import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/domain/csv';
import { generateConstraint } from '../src/domain/generatorA';
import { generateJointFilter } from '../src/domain/generatorB';
import { verifyQuality } from '../src/domain/verify';
import { checkAll } from '../src/domain/constraints';
import { defaultPlan, defaultRuleSet } from '../src/domain/defaults';
import { hashObject } from '../src/domain/hash';
import type { Plan, RuleSet, TableRows } from '../src/domain/types';

const SAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples', 'emerg-2025-09', 'r2');

function loadSample(): TableRows {
  const read = (n: string) => parseCsv(readFileSync(join(SAMPLE_DIR, n), 'utf8'));
  return {
    events: read('events.csv') as never,
    dispatches: read('dispatches.csv') as never,
    resources: read('resources.csv') as never,
    arrivals: read('arrivals.csv') as never,
    closures: read('closures.csv') as never
  };
}

let source: TableRows;
let ruleSet: RuleSet;
let plan: Plan;

beforeAll(() => {
  source = loadSample();
  ruleSet = { ...defaultRuleSet('2025-01-01T00:00:00Z'), id: 'RS-T', version: 1, status: 'approved', hash: 't' };
  plan = defaultPlan('PL-T', 'emerg-2025-09@r2', 'RS-T', 1, source, '2025-01-01T00:00:00Z');
  plan.targetEvents = 300;
  plan.seed = 20251001;
});

describe('随题样例（r2 修订）', () => {
  it('覆盖并发派车、多级转运、罕见组合、跨午夜', () => {
    const multi = new Map<string, number>();
    for (const d of source.dispatches) multi.set(d.event_id, (multi.get(d.event_id) ?? 0) + 1);
    const multiCount = [...multi.values()].filter((n) => n > 1).length;
    expect(multiCount).toBeGreaterThan(10); // 并发 + 转运链
    const hazSub = source.events.filter((e) => e.event_type === '危化品泄漏' && e.district === '郊区');
    expect(hazSub.length).toBeGreaterThanOrEqual(2); // 罕见组合
    const lateNight = source.events.filter((e) => e.alarm_time.slice(11, 13) === '23');
    expect(lateNight.length).toBeGreaterThanOrEqual(6); // 跨午夜
  });

  it('r1 存在待修订问题，r2 已修复（迟到源修订）', () => {
    const load = (rev: string): TableRows => {
      const read = (n: string) => parseCsv(readFileSync(join(SAMPLE_DIR, '..', rev, n), 'utf8'));
      return { events: read('events.csv') as never, dispatches: read('dispatches.csv') as never, resources: read('resources.csv') as never, arrivals: read('arrivals.csv') as never, closures: read('closures.csv') as never };
    };
    const r1 = load('r1');
    const r2 = load('r2');
    // r1：2 条派遣缺到场 + 3 条结案早于末次到场
    const arrD1 = new Set(r1.arrivals.map((a) => a.dispatch_id));
    expect(r1.dispatches.filter((d) => !arrD1.has(d.dispatch_id)).length).toBe(2);
    const v1 = checkAll(r1, ruleSet).filter((v) => v.kind === 'order' || v.kind === 'coverage');
    expect(v1.length).toBeGreaterThan(0);
    // r2：全部修复
    const arrD2 = new Set(r2.arrivals.map((a) => a.dispatch_id));
    expect(r2.dispatches.filter((d) => !arrD2.has(d.dispatch_id)).length).toBe(0);
    const v2 = checkAll(r2, ruleSet);
    expect(v2).toEqual([]);
    // 同一批次不同修订：文件内容不同
    expect(JSON.stringify(r1.closures)).not.toBe(JSON.stringify(r2.closures));
  });
});

describe('路线 A：约束驱动条件采样', () => {
  it('生成规模正确且满足全部关系规则', () => {
    const res = generateConstraint({ plan, ruleSet, source });
    expect(res.tables.events.length).toBeGreaterThanOrEqual(plan.targetEvents * 0.95);
    const violations = checkAll(res.tables, ruleSet);
    expect(violations).toEqual([]);
  });

  it('通过质量核验（不为 FAIL）', async () => {
    const res = generateConstraint({ plan, ruleSet, source });
    const report = await verifyQuality({ syn: res.tables, src: source, plan, ruleSet });
    expect(report.overall).not.toBe('FAIL');
  });

  it('同一种子输出完全可复现', async () => {
    const r1 = generateConstraint({ plan, ruleSet, source });
    const r2 = generateConstraint({ plan, ruleSet, source });
    expect(await hashObject(r1.tables)).toBe(await hashObject(r2.tables));
  });

  it('不同种子输出不同', async () => {
    const p2 = { ...plan, seed: 999 };
    const r1 = generateConstraint({ plan, ruleSet, source });
    const r2 = generateConstraint({ plan: p2, ruleSet, source });
    expect(await hashObject(r1.tables)).not.toBe(await hashObject(r2.tables));
  });
});

describe('路线 B：分布学习 + 批量抽样 + 约束筛选', () => {
  it('生成规模接近目标且满足全部关系规则', () => {
    const res = generateJointFilter({ plan, ruleSet, source });
    expect(res.tables.events.length).toBeGreaterThanOrEqual(plan.targetEvents * 0.9);
    expect(res.stats.filterRate).toBeGreaterThan(0);
    expect(res.stats.filterRate).toBeLessThan(0.9);
    const violations = checkAll(res.tables, ruleSet);
    expect(violations).toEqual([]);
  });

  it('通过质量核验（不为 FAIL）', async () => {
    const res = generateJointFilter({ plan, ruleSet, source });
    const report = await verifyQuality({ syn: res.tables, src: source, plan, ruleSet });
    expect(report.overall).not.toBe('FAIL');
  });

  it('同一种子输出完全可复现', async () => {
    const r1 = generateJointFilter({ plan, ruleSet, source });
    const r2 = generateJointFilter({ plan, ruleSet, source });
    expect(await hashObject(r1.tables)).toBe(await hashObject(r2.tables));
  });
});

describe('两条路线的输出标识', () => {
  it('合成标识不与源标识重叠', () => {
    const resA = generateConstraint({ plan, ruleSet, source });
    const resB = generateJointFilter({ plan, ruleSet, source });
    const srcIds = new Set(source.events.map((e) => e.event_id));
    for (const e of [...resA.tables.events, ...resB.tables.events]) {
      expect(srcIds.has(e.event_id)).toBe(false);
      expect(e.event_id.startsWith('EVT-S')).toBe(true);
    }
    const srcRes = new Set(source.resources.map((r) => r.resource_id));
    for (const r of [...resA.tables.resources, ...resB.tables.resources]) {
      expect(srcRes.has(r.resource_id)).toBe(false);
    }
  });
});

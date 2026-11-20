import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/db/db';
import { savePlan, approvePlan } from '../src/services/planService';
import { defaultPlan, defaultRuleSet } from '../src/domain/defaults';
import type { RuleSet, TableRows } from '../src/domain/types';

const emptyRows: TableRows = { events: [], dispatches: [], resources: [], arrivals: [], closures: [] };

function makePlan(id: string) {
  return defaultPlan(id, 'b@r1', 'RS-1', 1, emptyRows, new Date().toISOString());
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('方案并发保存（乐观锁）', () => {
  it('并发保存时后保存者收到字段级冲突', async () => {
    const p = makePlan('PL-1');
    await db.plans.put(p); // v0 落库

    // 管理员A 与 管理员B 同时基于 v0 编辑
    const editA = { ...p, name: '方案-A改', targetEvents: 500 };
    const editB = { ...p, name: '方案-B改', seed: 777 };

    const r1 = await savePlan(editA, 0);
    expect(r1.ok).toBe(true);

    const r2 = await savePlan(editB, 0); // B 仍基于 v0
    expect(r2.ok).toBe(false);
    if (!r2.ok && r2.conflict) {
      const fields = r2.conflicts.map((c) => c.field);
      expect(fields).toContain('name');
      expect(fields).toContain('targetEvents');
      // seed 两边相同（B 改了 seed 而 A 没改）——A 的库里 seed 是原值，B 的是 777 → 也冲突
      expect(fields).toContain('seed');
    }
  });

  it('强制覆盖可保存', async () => {
    const p = makePlan('PL-2');
    await db.plans.put(p);
    await savePlan({ ...p, name: 'A' }, 0);
    const r = await savePlan({ ...p, name: 'B' }, 0, { force: true });
    expect(r.ok).toBe(true);
  });
});

describe('审批门禁', () => {
  it('未审规则不能进入已批准方案', async () => {
    const rs: RuleSet = { ...defaultRuleSet(new Date().toISOString()), id: 'RS-1', version: 1, status: 'draft', hash: 'x' };
    await db.ruleSets.put(rs);
    const p = makePlan('PL-3');
    await db.plans.put({ ...p, version: 1 });
    const res = await approvePlan('PL-3', '管理员A');
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('尚未审批'))).toBe(true);
  });

  it('宽松容差被门禁拒绝', async () => {
    const rs: RuleSet = { ...defaultRuleSet(new Date().toISOString()), id: 'RS-1', version: 1, status: 'approved', hash: 'x' };
    await db.ruleSets.put(rs);
    const p = makePlan('PL-4');
    p.tolerances.typeMixPP = 50; // 宽松
    await db.plans.put({ ...p, version: 1 });
    const res = await approvePlan('PL-4', '管理员A');
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('容差'))).toBe(true);
  });

  it('规则已审批且参数合规时批准成功', async () => {
    const rs: RuleSet = { ...defaultRuleSet(new Date().toISOString()), id: 'RS-1', version: 1, status: 'approved', hash: 'x' };
    await db.ruleSets.put(rs);
    const p = makePlan('PL-5');
    p.distributions.eventTypeMix = { 突发疾病: 1 };
    await db.plans.put({ ...p, version: 1 });
    const res = await approvePlan('PL-5', '管理员A');
    expect(res.ok).toBe(true);
    const after = await db.plans.get('PL-5');
    expect(after?.status).toBe('approved');
    expect(after?.approvedBy).toBe('管理员A');
  });
});

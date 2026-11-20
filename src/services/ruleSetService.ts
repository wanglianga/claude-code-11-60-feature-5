// 关系规则集：版本化、审批后不可变（再编辑自动生成新版本草稿）。

import { db } from '../db/db';
import type { RuleSet } from '../domain/types';
import { defaultRuleSet } from '../domain/defaults';
import { hashObject } from '../domain/hash';

export async function createDefaultRuleSet(now = new Date().toISOString()): Promise<RuleSet> {
  const base = defaultRuleSet(now);
  const id = `RS-${Date.now().toString(36)}`;
  const draft: RuleSet = { ...base, id, version: 1, status: 'draft', hash: '' };
  draft.hash = await hashObject({ name: draft.name, bounds: draft.bounds, capabilityMap: draft.capabilityMap, version: draft.version });
  await db.ruleSets.put(draft);
  return draft;
}

export async function saveRuleSet(rs: RuleSet): Promise<RuleSet> {
  const cur = await db.ruleSets.get(rs.id);
  if (cur?.status === 'approved') {
    // 已审批规则不可原地修改：保存为新版本草稿
    const next: RuleSet = {
      ...rs,
      version: cur.version + 1,
      status: 'draft',
      approvedBy: undefined,
      approvedAt: undefined,
      updatedAt: new Date().toISOString()
    };
    next.hash = await hashObject({ name: next.name, bounds: next.bounds, capabilityMap: next.capabilityMap, version: next.version });
    await db.ruleSets.put(next);
    return next;
  }
  rs.updatedAt = new Date().toISOString();
  rs.hash = await hashObject({ name: rs.name, bounds: rs.bounds, capabilityMap: rs.capabilityMap, version: rs.version });
  await db.ruleSets.put(rs);
  return rs;
}

export async function approveRuleSet(id: string, operator: string): Promise<{ ok: boolean; error?: string }> {
  const rs = await db.ruleSets.get(id);
  if (!rs) return { ok: false, error: '规则不存在' };
  if (rs.status === 'approved') return { ok: false, error: '该规则已审批' };
  const b = rs.bounds;
  if (b.responseMaxMin <= 0 || b.travelMaxMin <= 0 || b.totalMaxMin <= 0) return { ok: false, error: '时长上限必须为正数' };
  if (b.turnoverMin < 0 || b.transferGapMin < 0) return { ok: false, error: '周转/交接时间不能为负' };
  if (Object.keys(rs.capabilityMap).length === 0) return { ok: false, error: '能力映射不能为空' };
  await db.ruleSets.update(id, { status: 'approved', approvedBy: operator, approvedAt: new Date().toISOString() });
  return { ok: true };
}

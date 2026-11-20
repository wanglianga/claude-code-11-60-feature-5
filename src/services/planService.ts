// 生成方案：乐观锁保存（并发冲突字段级提示）+ 审批门禁（未审/宽松规则不得进入已批准方案）。

import { db } from '../db/db';
import type { Plan, ConflictField } from '../domain/types';
import { diffPlans } from '../domain/conflict';
import { lintPlan } from '../domain/defaults';

export type SaveResult =
  | { ok: true; plan: Plan }
  | { ok: false; conflict: true; conflicts: ConflictField[]; current: Plan }
  | { ok: false; conflict: false; error: string };

/**
 * 保存方案（乐观锁）：baseVersion 为编辑时读到的版本。
 * 若库中版本已变化（另一管理员已保存），返回字段级冲突清单，由界面展示后决定覆盖或放弃。
 */
export async function savePlan(plan: Plan, baseVersion: number, opts: { force?: boolean } = {}): Promise<SaveResult> {
  const cur = await db.plans.get(plan.id);
  if (cur && cur.version !== baseVersion && !opts.force) {
    const conflicts = diffPlans(plan, cur);
    if (conflicts.length > 0) return { ok: false, conflict: true, conflicts, current: cur };
  }
  if (cur?.status === 'approved') {
    return { ok: false, conflict: false, error: '已批准方案不可修改；如需调整请另存为新方案' };
  }
  const next: Plan = { ...plan, version: (cur?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
  await db.plans.put(next);
  return { ok: true, plan: next };
}

/** 审批方案：规则必须已审批且版本一致；lint 检查拒绝宽松参数 */
export async function approvePlan(id: string, operator: string): Promise<{ ok: boolean; errors: string[] }> {
  const plan = await db.plans.get(id);
  if (!plan) return { ok: false, errors: ['方案不存在'] };
  if (plan.status === 'approved') return { ok: false, errors: ['方案已批准'] };
  const errors: string[] = [];
  const rs = await db.ruleSets.get(plan.ruleSetId);
  if (!rs) {
    errors.push('引用的关系规则不存在');
  } else {
    if (rs.status !== 'approved') errors.push(`引用的规则「${rs.name} v${rs.version}」尚未审批——未审规则不得进入已批准方案`);
    if (rs.version !== plan.ruleSetVersion) errors.push(`规则已有新版本（方案引用 v${plan.ruleSetVersion}，当前 v${rs.version}），请确认后再批准`);
  }
  errors.push(...lintPlan(plan));
  if (errors.length > 0) return { ok: false, errors };
  await db.plans.update(id, {
    status: 'approved',
    approvedBy: operator,
    approvedAt: new Date().toISOString(),
    approvalChecks: [
      `规则 ${plan.ruleSetId} v${plan.ruleSetVersion} 已审批`,
      '容差参数在系统边界内（非宽松规则）',
      '种子/规模/声明组合完整'
    ]
  });
  return { ok: true, errors: [] };
}

export async function duplicatePlan(plan: Plan, now = new Date().toISOString()): Promise<Plan> {
  const copy: Plan = {
    ...structuredClone(plan),
    id: `PL-${Date.now().toString(36)}`,
    name: `${plan.name}（副本）`,
    version: 0,
    status: 'draft',
    approvedBy: undefined,
    approvedAt: undefined,
    approvalChecks: undefined,
    createdAt: now,
    updatedAt: now
  };
  await db.plans.put(copy);
  return copy;
}

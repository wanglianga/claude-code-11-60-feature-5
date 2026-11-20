// 方案并发保存：乐观锁 + 字段级冲突 diff。

import type { Plan, ConflictField } from './types';

/** 递归比较两个 JSON 值，返回叶级差异路径 */
export function diffValues(a: unknown, b: unknown, path = ''): ConflictField[] {
  const out: ConflictField[] = [];
  const fmt = (v: unknown) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 77) + '…' : s;
  };
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const aObj = a !== null && typeof a === 'object';
  const bObj = b !== null && typeof b === 'object';
  if (aObj && bObj) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) {
      if (['version', 'updatedAt', 'approvedAt', 'approvedBy', 'approvalChecks', 'status'].includes(k)) continue;
      out.push(...diffValues((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
    }
    return out;
  }
  out.push({ field: path || '(根)', yours: fmt(a), current: fmt(b) });
  return out;
}

/** 比较“我编辑的方案”与“库中当前方案”，给出冲突字段（忽略版本号等元字段） */
export function diffPlans(mine: Plan, current: Plan): ConflictField[] {
  return diffValues(mine, current).slice(0, 50);
}

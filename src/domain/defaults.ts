// 默认规则集与方案工厂。

import type { RuleSet, Plan, PlanTolerances, TableName } from './types';
import { learnDistributions } from './stats';
import type { TableRows } from './types';

export const EVENT_TYPES = ['突发疾病', '外伤急救', '交通事故', '火灾', '危化品泄漏', '其他'];

export function defaultRuleSet(now: string): Omit<RuleSet, 'id' | 'version' | 'hash' | 'status'> {
  return {
    name: '标准调度关系规则',
    bounds: {
      responseMaxMin: 30,
      travelMaxMin: 90,
      onSceneMaxMin: 240,
      totalMaxMin: 480,
      turnoverMin: 20,
      transferGapMin: 5
    },
    capabilityMap: {
      突发疾病: ['急救'],
      外伤急救: ['急救'],
      交通事故: ['急救'],
      火灾: ['消防'],
      危化品泄漏: ['危化'],
      其他: ['急救']
    },
    createdAt: now,
    updatedAt: now
  };
}

export const DEFAULT_TOLERANCES: PlanTolerances = {
  typeMixPP: 5,
  histPP: 9,
  meanRelPct: 18,
  volumeRelPct: 25,
  nearCopyWarn: 0.85,
  nearCopyFail: 0.95,
  kAnonymity: 3
};

/** 审批 lint 的系统边界：超出即视为“宽松规则”，不得进入已批准方案 */
export const LINT_BOUNDS = {
  typeMixPP: { min: 1, max: 10 },
  histPP: { min: 2, max: 15 },
  meanRelPct: { min: 5, max: 25 },
  volumeRelPct: { min: 5, max: 40 },
  kAnonymity: { min: 2, max: 10 },
  targetEvents: { min: 10, max: 5000 }
};

export function lintPlan(plan: Plan): string[] {
  const errs: string[] = [];
  const t = plan.tolerances;
  const inRange = (v: number, r: { min: number; max: number }) => v >= r.min && v <= r.max;
  if (!inRange(t.typeMixPP, LINT_BOUNDS.typeMixPP)) errs.push(`类型占比容差须在 ${LINT_BOUNDS.typeMixPP.min}~${LINT_BOUNDS.typeMixPP.max}pp 内`);
  if (!inRange(t.histPP, LINT_BOUNDS.histPP)) errs.push(`直方图容差须在 ${LINT_BOUNDS.histPP.min}~${LINT_BOUNDS.histPP.max}pp 内`);
  if (!inRange(t.meanRelPct, LINT_BOUNDS.meanRelPct)) errs.push(`均值容差须在 ${LINT_BOUNDS.meanRelPct.min}~${LINT_BOUNDS.meanRelPct.max}% 内`);
  if (!inRange(t.volumeRelPct, LINT_BOUNDS.volumeRelPct)) errs.push(`日量容差须在 ${LINT_BOUNDS.volumeRelPct.min}~${LINT_BOUNDS.volumeRelPct.max}% 内`);
  if (!inRange(t.kAnonymity, LINT_BOUNDS.kAnonymity)) errs.push(`k 匿名阈值须在 ${LINT_BOUNDS.kAnonymity.min}~${LINT_BOUNDS.kAnonymity.max} 内`);
  if (!(t.nearCopyFail > t.nearCopyWarn)) errs.push('近乎复制失败阈值必须大于告警阈值');
  if (!inRange(plan.targetEvents, LINT_BOUNDS.targetEvents)) errs.push(`目标事件数须在 ${LINT_BOUNDS.targetEvents.min}~${LINT_BOUNDS.targetEvents.max} 内`);
  if (!Number.isInteger(plan.seed)) errs.push('随机种子必须为整数');
  if (plan.quasiCombos.length === 0) errs.push('至少声明一个字段组合用于独特性检查');
  const mixSum = Object.values(plan.distributions.eventTypeMix).reduce((a, b) => a + b, 0);
  if (Math.abs(mixSum - 1) > 0.02) errs.push(`事件类型占比之和应为 1（当前 ${mixSum.toFixed(3)}）`);
  if (plan.dateRange.days < 1 || plan.dateRange.days > 92) errs.push('生成日期跨度须在 1~92 天内');
  return errs;
}

export const DEFAULT_EXPORT_FIELDS: Record<TableName, string[]> = {
  events: ['event_id', 'alarm_time', 'event_type', 'district', 'address_text', 'caller_phone', 'priority'],
  dispatches: ['dispatch_id', 'event_id', 'resource_id', 'dispatch_time'],
  resources: ['resource_id', 'resource_type', 'station', 'capability'],
  arrivals: ['arrival_id', 'dispatch_id', 'arrive_time', 'arrive_site'],
  closures: ['closure_id', 'event_id', 'close_time', 'outcome']
};

export function defaultPlan(id: string, batchKey: string, ruleSetId: string, ruleSetVersion: number, source: TableRows, now: string): Plan {
  return {
    id,
    name: '演练方案',
    version: 0,
    status: 'draft',
    ruleSetId,
    ruleSetVersion,
    batchKey,
    method: 'constraint',
    targetEvents: 300,
    seed: 20251001,
    dateRange: { start: '2025-10-01 00:00:00', days: 30 },
    resourcePool: { ambulances: 8, fireTrucks: 4, hazmat: 2 },
    tolerances: { ...DEFAULT_TOLERANCES },
    quasiCombos: [
      ['event_type', 'district', 'priority'],
      ['event_type', 'chain_pattern', 'outcome']
    ],
    exportFields: structuredClone(DEFAULT_EXPORT_FIELDS),
    distributions: learnDistributions(source),
    createdAt: now,
    updatedAt: now
  };
}

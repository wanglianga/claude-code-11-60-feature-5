// 质量核验：约定的总体统计比对 + 引用完整性 + 资源占用 + 时间可行性 + 基础风险核验。
// 对两条生成路线使用完全相同的核验逻辑。

import type { Plan, PlanDistributions, Report, ReportSection, CheckItem, RiskItem, RuleSet, TableRows, Level } from './types';
import { learnDistributions } from './stats';
import { checkReferential, checkChainTiming, checkResourceOccupancy, checkCapability } from './constraints';
import { scanDirectIdentifiers, detectNearCopies, checkUniqueCombos, COMBO_FIELD_LABELS } from './privacy';
import { hashObject } from './hash';

export const DISCLAIMER =
  '基础风险核验仅覆盖：①导出字段中的直接标识（模式匹配与源值逐字比对）；②与源记录的近乎复制；③已声明字段组合的独特性。' +
  '本核验不宣称能抵御针对特定目标的定制攻击、背景知识链接攻击或组合推断攻击；演练包应按内部受控资料管理。';

function worstLevel(items: CheckItem[]): Level {
  if (items.some((i) => i.level === 'fail')) return 'fail';
  if (items.some((i) => i.level === 'warn')) return 'warn';
  return 'pass';
}

function pct(x: number): string { return (x * 100).toFixed(1) + '%'; }

function compareMix(
  items: CheckItem[],
  label: string,
  srcMix: Record<string, number>,
  synMix: Record<string, number>,
  tolPP: number
): void {
  const keys = new Set([...Object.keys(srcMix), ...Object.keys(synMix)]);
  let maxDiff = 0;
  let maxKey = '';
  for (const k of keys) {
    const a = srcMix[k] ?? 0;
    const b = synMix[k] ?? 0;
    const d = Math.abs(a - b);
    if (d > maxDiff) { maxDiff = d; maxKey = k; }
  }
  items.push({
    label,
    level: maxDiff * 100 <= tolPP ? 'pass' : 'fail',
    source: `峰值类「${maxKey}」${pct(srcMix[maxKey] ?? 0)}`,
    synthetic: pct(synMix[maxKey] ?? 0),
    tol: `±${tolPP}pp`,
    detail: `最大占比偏差 ${(maxDiff * 100).toFixed(1)}pp（${maxKey}）`
  });
}

function compareHist(
  items: CheckItem[],
  label: string,
  src: { edges: number[]; counts: number[] },
  syn: { edges: number[]; counts: number[] },
  tolPP: number,
  meanRelPct: number
): void {
  const srcTotal = src.counts.reduce((a, b) => a + b, 0) || 1;
  const synTotal = syn.counts.reduce((a, b) => a + b, 0) || 1;
  let maxDiff = 0;
  let maxBucket = '';
  for (let i = 0; i < src.counts.length; i++) {
    const d = Math.abs(src.counts[i] / srcTotal - (syn.counts[i] ?? 0) / synTotal);
    if (d > maxDiff) { maxDiff = d; maxBucket = `${src.edges[i]}~${src.edges[i + 1] ?? '∞'}分`; }
  }
  const meanOf = (h: { edges: number[]; counts: number[] }, total: number) => {
    let m = 0;
    for (let i = 0; i < h.counts.length; i++) {
      const mid = (h.edges[i] + (h.edges[i + 1] ?? h.edges[i] * 1.5 + 1)) / 2;
      m += (h.counts[i] / total) * mid;
    }
    return m;
  };
  const srcMean = meanOf(src, srcTotal);
  const synMean = meanOf(syn, synTotal);
  const meanRel = srcMean > 0 ? Math.abs(synMean - srcMean) / srcMean : 0;
  const ok = maxDiff * 100 <= tolPP && meanRel * 100 <= meanRelPct;
  items.push({
    label,
    level: ok ? 'pass' : 'fail',
    source: `均值 ${srcMean.toFixed(1)} 分`,
    synthetic: `均值 ${synMean.toFixed(1)} 分`,
    tol: `桶±${tolPP}pp / 均值±${meanRelPct}%`,
    detail: `最大桶偏差 ${(maxDiff * 100).toFixed(1)}pp（${maxBucket}），均值相对偏差 ${(meanRel * 100).toFixed(1)}%`
  });
}

export interface VerifyInput {
  syn: TableRows;
  src: TableRows;
  plan: Plan;
  ruleSet: RuleSet;
}

export async function verifyQuality(input: VerifyInput): Promise<Omit<Report, 'id' | 'runId' | 'createdAt'>> {
  const { syn, src, plan, ruleSet } = input;
  const tol = plan.tolerances;
  const sections: ReportSection[] = [];
  const risks: RiskItem[] = [];

  // ---- 1. 总体统计 ----
  const statItems: CheckItem[] = [];
  const srcDist: PlanDistributions = learnDistributions(src);
  const synDist: PlanDistributions = learnDistributions(syn);
  compareMix(statItems, '事件类型占比', srcDist.eventTypeMix, synDist.eventTypeMix, tol.typeMixPP);
  compareMix(statItems, '行政区占比', srcDist.districtMix, synDist.districtMix, tol.typeMixPP);
  // 优先级：直接比较全局边际分布
  const globalMix = (rows: TableRows, field: 'priority') => {
    const m: Record<string, number> = {};
    for (const e of rows.events) m[e[field]] = (m[e[field]] ?? 0) + 1;
    const total = rows.events.length || 1;
    for (const k of Object.keys(m)) m[k] /= total;
    return m;
  };
  compareMix(statItems, '优先级占比', globalMix(src, 'priority'), globalMix(syn, 'priority'), tol.typeMixPP);
  compareHist(statItems, '响应时长分布（报警→派遣）', srcDist.durationHists.response, synDist.durationHists.response, tol.histPP, tol.meanRelPct);
  compareHist(statItems, '行驶时长分布（派遣→到场）', srcDist.durationHists.travel, synDist.durationHists.travel, tol.histPP, tol.meanRelPct);
  compareHist(statItems, '现场处置时长分布', srcDist.durationHists.onScene, synDist.durationHists.onScene, tol.histPP, tol.meanRelPct);
  compareHist(statItems, '全程时长分布（报警→结案）', srcDist.durationHists.total, synDist.durationHists.total, tol.histPP, tol.meanRelPct);
  // 日量：与方案约定的日量（目标事件数/跨度天数）比对；源批次日量作为参照展示
  const days = Math.max(1, plan.dateRange.days);
  const srcDays = Math.max(1, new Set(src.events.map((e) => e.alarm_time.slice(0, 10))).size);
  const srcDaily = src.events.length / srcDays;
  const planDaily = plan.targetEvents / days;
  const synDaily = syn.events.length / days;
  const volRel = planDaily > 0 ? Math.abs(synDaily - planDaily) / planDaily : 0;
  statItems.push({
    label: '日均事件量（对方案约定）',
    level: volRel * 100 <= tol.volumeRelPct ? 'pass' : 'fail',
    source: `源批次 ${srcDaily.toFixed(1)}/日（参照）`,
    synthetic: `${synDaily.toFixed(1)}/日（约定 ${planDaily.toFixed(1)}）`,
    tol: `±${tol.volumeRelPct}%`,
    detail: `相对约定偏差 ${(volRel * 100).toFixed(1)}%`
  });
  sections.push({ key: 'stats', title: '总体统计比对', level: worstLevel(statItems), items: statItems });

  // ---- 2. 引用完整性 ----
  const refV = checkReferential(syn);
  const refItems: CheckItem[] = [{
    label: '外键引用与覆盖性',
    level: refV.length === 0 ? 'pass' : 'fail',
    synthetic: refV.length === 0 ? '全部满足' : `${refV.length} 处违例`,
    detail: refV.slice(0, 5).map((x) => x.message).join('；') || '事件/派遣/资源/到场/结案引用闭合，覆盖完整'
  }];
  sections.push({ key: 'ref', title: '引用完整性', level: worstLevel(refItems), items: refItems });

  // ---- 3. 资源占用 ----
  const occV = checkResourceOccupancy(syn, ruleSet);
  const capV = checkCapability(syn, ruleSet);
  const occItems: CheckItem[] = [
    {
      label: '车辆任务区间（按绝对时间核验，跨午夜安全）',
      level: occV.length === 0 ? 'pass' : 'fail',
      synthetic: occV.length === 0 ? '无重叠' : `${occV.length} 处重叠`,
      detail: occV.slice(0, 5).map((x) => x.message).join('；') || `占用区间=[派遣, 到场+${ruleSet.bounds.turnoverMin}分周转]，逐车核验无重叠`
    },
    {
      label: '资源能力匹配',
      level: capV.length === 0 ? 'pass' : 'fail',
      synthetic: capV.length === 0 ? '全部匹配' : `${capV.length} 处不匹配`,
      detail: capV.slice(0, 5).map((x) => x.message).join('；') || '派遣资源能力覆盖事件类型所需'
    }
  ];
  sections.push({ key: 'resource', title: '资源占用核验', level: worstLevel(occItems), items: occItems });

  // ---- 4. 时间可行性 ----
  const timeV = checkChainTiming(syn, ruleSet);
  const timeItems: CheckItem[] = [{
    label: '链级先后约束与时长边界',
    level: timeV.length === 0 ? 'pass' : 'fail',
    synthetic: timeV.length === 0 ? '全部满足' : `${timeV.length} 处违例`,
    detail: timeV.slice(0, 5).map((x) => x.message).join('；') ||
      `报警≤派遣≤到场≤结案，转运交接≥${ruleSet.bounds.transferGapMin}分，响应≤${ruleSet.bounds.responseMaxMin}分，全程≤${ruleSet.bounds.totalMaxMin}分`
  }];
  sections.push({ key: 'time', title: '时间可行性', level: worstLevel(timeItems), items: timeItems });

  // ---- 5. 直接标识 ----
  const directHits = scanDirectIdentifiers(syn, src, plan.exportFields);
  const directItems: CheckItem[] = [{
    label: '导出字段直接标识扫描',
    level: directHits.length === 0 ? 'pass' : 'fail',
    synthetic: directHits.length === 0 ? '未发现' : `${directHits.length} 处命中`,
    detail: directHits.slice(0, 5).map((h) => `${h.table}.${h.field}「${h.value}」${h.reason}`).join('；') || '手机号/身份证/邮箱/银行卡模式与源直接字段逐字比对均未命中'
  }];
  if (directHits.length > 0) risks.push({ level: 'high', kind: '直接标识', message: `导出字段发现 ${directHits.length} 处直接标识命中`, detail: directHits[0] ? `${directHits[0].table}.${directHits[0].field}` : undefined });
  sections.push({ key: 'direct', title: '直接标识检查', level: worstLevel(directItems), items: directItems });

  // ---- 6. 源记录近乎复制 ----
  const nc = detectNearCopies(syn, src, tol.nearCopyWarn, tol.nearCopyFail);
  const ncItems: CheckItem[] = [{
    label: '与源记录的相似度',
    level: nc.fail.length > 0 ? 'fail' : nc.warn.length > 0 ? 'warn' : 'pass',
    synthetic: `最大相似度 ${(nc.maxSim * 100).toFixed(1)}%`,
    tol: `告警≥${(tol.nearCopyWarn * 100).toFixed(0)}% / 失败≥${(tol.nearCopyFail * 100).toFixed(0)}%`,
    detail: `失败级 ${nc.fail.length} 条，告警级 ${nc.warn.length} 条`
  }];
  if (nc.fail.length > 0) risks.push({ level: 'high', kind: '近乎复制', message: `${nc.fail.length} 条合成事件与源记录高度相似（≥${(tol.nearCopyFail * 100).toFixed(0)}%）`, detail: nc.fail.slice(0, 3).map((h) => `${h.syntheticEventId}≈${h.sourceEventId}(${(h.similarity * 100).toFixed(0)}%)`).join('；') });
  if (nc.warn.length > 0) risks.push({ level: 'medium', kind: '近乎复制', message: `${nc.warn.length} 条合成事件与源记录中度相似（≥${(tol.nearCopyWarn * 100).toFixed(0)}%）`, detail: nc.warn.slice(0, 3).map((h) => `${h.syntheticEventId}≈${h.sourceEventId}(${(h.similarity * 100).toFixed(0)}%)`).join('；') });
  sections.push({ key: 'nearcopy', title: '源记录近乎复制检测', level: worstLevel(ncItems), items: ncItems });

  // ---- 7. 已声明字段组合的独特性 ----
  const comboRisks = checkUniqueCombos(syn, plan.quasiCombos, tol.kAnonymity);
  const comboItems: CheckItem[] = plan.quasiCombos.map((combo) => {
    const list = comboRisks.filter((r) => r.combo === combo);
    return {
      label: `组合 [${combo.map((f) => COMBO_FIELD_LABELS[f] ?? f).join(' + ')}]`,
      level: list.length === 0 ? 'pass' : 'warn',
      synthetic: list.length === 0 ? `所有组合计数 ≥ ${tol.kAnonymity}` : `${list.length} 个组合计数 < ${tol.kAnonymity}`,
      detail: list.slice(0, 4).map((r) => `「${r.key}」仅 ${r.count} 条`).join('；') || undefined
    };
  });
  if (comboRisks.length > 0) {
    risks.push({
      level: 'medium',
      kind: '独特组合',
      message: `${comboRisks.length} 个已声明字段组合的计数低于 k=${tol.kAnonymity}，可能被链接定位`,
      detail: comboRisks.slice(0, 5).map((r) => `「${r.key}」=${r.count}`).join('；')
    });
  }
  sections.push({ key: 'combo', title: '已声明字段组合独特性', level: worstLevel(comboItems), items: comboItems });

  const overall: Report['overall'] = sections.some((s) => s.level === 'fail') ? 'FAIL' : sections.some((s) => s.level === 'warn') ? 'WARN' : 'PASS';
  const body = { overall, sections, risks, disclaimer: DISCLAIMER };
  const hash = await hashObject(body);
  return { ...body, hash };
}

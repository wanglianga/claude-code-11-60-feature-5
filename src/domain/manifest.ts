// 发布清单：由输入计算产生，可回查来源批次、规则、运行参数与核验结果。

import type { Manifest, Run, Report, BatchMeta } from './types';
import { hashObject } from './hash';

export async function buildManifest(run: Run, report: Report, batch: BatchMeta, createdBy: string, now: string): Promise<Manifest> {
  const fileHashes: Record<string, string> = {};
  for (const f of batch.files) fileHashes[f.name] = f.sha256;
  const base = {
    runId: run.id,
    reportId: report.id,
    createdAt: now,
    createdBy,
    batch: { batchId: batch.batchId, revision: batch.revision, batchKey: batch.key, fileHashes },
    ruleSet: { id: run.ruleSetId, version: run.ruleSetVersion, hash: run.ruleSetHash, approvedBy: run.ruleSetSnapshot.approvedBy },
    plan: {
      id: run.planId,
      version: run.planVersion,
      hash: run.planHash,
      method: run.method,
      seed: run.seed,
      targetEvents: run.targetEvents
    },
    run: { id: run.id, seq: run.seq, startedAt: run.startedAt, finishedAt: run.finishedAt, stats: run.stats, outputHashes: run.outputHashes },
    report: { id: report.id, overall: report.overall, hash: report.hash, riskCount: report.risks.length }
  };
  const manifestHash = await hashObject(base);
  return { id: `MFT-${String(run.seq).padStart(4, '0')}`, ...base, manifestHash };
}

/** 回查校验：用当前库存内容重算各部分哈希，逐项比对 */
export async function recheckManifest(
  m: Manifest,
  current: { batch?: BatchMeta; reportHash?: string }
): Promise<{ item: string; expected: string; actual: string; ok: boolean }[]> {
  const out: { item: string; expected: string; actual: string; ok: boolean }[] = [];
  if (current.batch) {
    const fileHashes: Record<string, string> = {};
    for (const f of current.batch.files) fileHashes[f.name] = f.sha256;
    const ok = JSON.stringify(fileHashes) === JSON.stringify(m.batch.fileHashes);
    out.push({
      item: `来源批次 ${m.batch.batchId}@r${m.batch.revision} 文件哈希`,
      expected: Object.values(m.batch.fileHashes).map((h) => h.slice(0, 12)).join(','),
      actual: Object.values(fileHashes).map((h) => h.slice(0, 12)).join(','),
      ok
    });
  } else {
    out.push({ item: '来源批次', expected: '存在', actual: '已缺失', ok: false });
  }
  if (current.reportHash) {
    out.push({
      item: '核验报告哈希',
      expected: m.report.hash.slice(0, 16),
      actual: current.reportHash.slice(0, 16),
      ok: current.reportHash === m.report.hash
    });
  }
  return out;
}

// 生成运行编排：固定来源与规则快照 -> WebWorker 生成 -> 输出落库。
// 运行期间若批次被修订，当前运行继续引用启动快照，并记录提示。

import { db, nextSeq } from '../db/db';
import type { Run, Plan, TableRows, TableName } from '../domain/types';
import { TABLE_NAMES } from '../domain/types';
import { hashObject, sha256Hex } from '../domain/hash';
import { toCsv } from '../domain/csv';
import { DEFAULT_EXPORT_FIELDS } from '../domain/defaults';

export async function startRun(plan: Plan, onProgress?: (done: number, total: number) => void): Promise<{ ok: true; run: Run } | { ok: false; error: string }> {
  if (plan.status !== 'approved') return { ok: false, error: '只有已批准方案可以启动生成' };
  const batch = await db.batches.get(plan.batchKey);
  const rows = (await db.batchRows.get(plan.batchKey))?.tables;
  const ruleSet = await db.ruleSets.get(plan.ruleSetId);
  if (!batch || !rows) return { ok: false, error: `来源批次 ${plan.batchKey} 不存在` };
  if (!ruleSet) return { ok: false, error: '规则集不存在' };
  if (ruleSet.status !== 'approved') return { ok: false, error: '规则集未审批' };

  const seq = await nextSeq('runSeq');
  const batchFileHashes: Record<string, string> = {};
  for (const f of batch.files) batchFileHashes[f.name] = f.sha256;
  const planHash = await hashObject({
    method: plan.method, seed: plan.seed, targetEvents: plan.targetEvents, dateRange: plan.dateRange,
    resourcePool: plan.resourcePool, tolerances: plan.tolerances, quasiCombos: plan.quasiCombos,
    exportFields: plan.exportFields, distributions: plan.distributions, ruleSetVersion: plan.ruleSetVersion, batchKey: plan.batchKey
  });

  const run: Run = {
    id: `RUN-${String(seq).padStart(4, '0')}`,
    seq,
    planId: plan.id,
    planVersion: plan.version,
    status: 'running',
    method: plan.method,
    seed: plan.seed,
    targetEvents: plan.targetEvents,
    batchKey: batch.key,
    batchRevision: batch.revision,
    batchFileHashes,
    ruleSetId: ruleSet.id,
    ruleSetVersion: ruleSet.version,
    ruleSetHash: ruleSet.hash,
    planHash,
    planSnapshot: structuredClone(plan),
    ruleSetSnapshot: structuredClone(ruleSet),
    startedAt: new Date().toISOString()
  };
  await db.runs.put(run);

  try {
    const result = await runGenerationWorker(plan, ruleSet, rows, onProgress);
    const outputHashes = await hashTables(result.tables, plan.exportFields);
    // 运行期间批次是否已有新修订
    const latest = await db.batches.where('batchId').equals(batch.batchId).toArray();
    const newer = latest.filter((b) => b.revision > batch.revision);
    const notice = newer.length > 0
      ? `批次已存在更新修订 r${Math.max(...newer.map((b) => b.revision))}；本运行结果仍引用启动快照 r${batch.revision}，使用新修订请另起运行`
      : undefined;
    const done: Run = {
      ...run,
      status: 'done',
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(run.startedAt).getTime(),
      stats: result.stats,
      outputHashes,
      notice
    };
    await db.runs.put(done);
    await db.runOutputs.put({ runId: run.id, tables: result.tables });
    return { ok: true, run: done };
  } catch (e) {
    const failed: Run = { ...run, status: 'failed', finishedAt: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) };
    await db.runs.put(failed);
    return { ok: false, error: failed.error ?? '生成失败' };
  }
}

function runGenerationWorker(
  plan: Plan,
  ruleSet: Run['ruleSetSnapshot'],
  source: TableRows,
  onProgress?: (done: number, total: number) => void
): Promise<{ tables: TableRows; stats: NonNullable<Run['stats']> }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/generation.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('生成超时（120s）')); }, 120_000);
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') onProgress?.(msg.done, msg.total);
      else if (msg.type === 'done') {
        clearTimeout(timer);
        worker.terminate();
        resolve(msg.result);
      } else if (msg.type === 'error') {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(msg.error));
      }
    };
    worker.onerror = (e) => { clearTimeout(timer); worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage({ type: 'generate', payload: { plan, ruleSet, source } });
  });
}

export async function hashTables(tables: TableRows, exportFields?: Record<TableName, string[]>): Promise<Record<TableName, string>> {
  const out = {} as Record<TableName, string>;
  for (const t of TABLE_NAMES) {
    const cols = exportFields?.[t] ?? DEFAULT_EXPORT_FIELDS[t];
    out[t] = await sha256Hex(toCsv(tables[t] as unknown as Record<string, string>[], cols));
  }
  return out;
}

export async function getRunOutput(runId: string): Promise<TableRows | undefined> {
  return (await db.runOutputs.get(runId))?.tables;
}

// 发布清单：由运行 + 核验报告 + 批次计算产生。

import { db } from '../db/db';
import type { Manifest } from '../domain/types';
import { buildManifest } from '../domain/manifest';

export async function createManifest(runId: string, operator: string): Promise<{ ok: true; manifest: Manifest } | { ok: false; error: string }> {
  const run = await db.runs.get(runId);
  if (!run) return { ok: false, error: '运行不存在' };
  if (run.status !== 'done') return { ok: false, error: '运行未完成，不能发布' };
  const report = await db.reports.get(`RPT-${String(run.seq).padStart(4, '0')}`);
  if (!report) return { ok: false, error: '请先完成质量核验再生成发布清单' };
  if (report.overall === 'FAIL') return { ok: false, error: '核验结论为 FAIL，不能发布；请调整方案后重新生成' };
  const batch = await db.batches.get(run.batchKey);
  if (!batch) return { ok: false, error: '来源批次缺失' };
  const existing = await db.manifests.where('runId').equals(runId).first();
  if (existing) return { ok: true, manifest: existing };
  const manifest = await buildManifest(run, report, batch, operator, new Date().toISOString());
  await db.manifests.put(manifest);
  return { ok: true, manifest };
}

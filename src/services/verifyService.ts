// 质量核验编排：WebWorker 中执行，报告落库。

import { db } from '../db/db';
import type { Report, Run, TableRows } from '../domain/types';
import { getRunOutput } from './runService';

export async function startVerification(runId: string): Promise<{ ok: true; report: Report } | { ok: false; error: string }> {
  const run = await db.runs.get(runId);
  if (!run) return { ok: false, error: '运行不存在' };
  if (run.status !== 'done') return { ok: false, error: '运行尚未完成' };
  const syn = await getRunOutput(runId);
  const src = (await db.batchRows.get(run.batchKey))?.tables;
  if (!syn || !src) return { ok: false, error: '缺少合成输出或来源批次数据' };

  try {
    const body = await runVerifyWorker(run, syn, src);
    const report: Report = {
      id: `RPT-${String(run.seq).padStart(4, '0')}`,
      runId: run.id,
      createdAt: new Date().toISOString(),
      ...body
    };
    await db.reports.put(report);
    return { ok: true, report };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function runVerifyWorker(run: Run, syn: TableRows, src: TableRows): Promise<Omit<Report, 'id' | 'runId' | 'createdAt'>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/verification.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('核验超时（120s）')); }, 120_000);
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'done') { clearTimeout(timer); worker.terminate(); resolve(msg.result); }
      else if (msg.type === 'error') { clearTimeout(timer); worker.terminate(); reject(new Error(msg.error)); }
    };
    worker.onerror = (e) => { clearTimeout(timer); worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage({
      type: 'verify',
      payload: { syn, src, plan: run.planSnapshot, ruleSet: run.ruleSetSnapshot }
    });
  });
}

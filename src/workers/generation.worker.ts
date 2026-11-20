// 生成 Worker：在后台线程执行两条生成路线之一。

import { generateConstraint } from '../domain/generatorA';
import { generateJointFilter } from '../domain/generatorB';
import type { GenPayload } from '../domain/types';

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg?.type !== 'generate') return;
  try {
    const payload = msg.payload as GenPayload;
    const onProgress = (done: number, total: number) => {
      (self as unknown as Worker).postMessage({ type: 'progress', done, total });
    };
    const result = payload.plan.method === 'joint-filter'
      ? generateJointFilter(payload, onProgress)
      : generateConstraint(payload, onProgress);
    (self as unknown as Worker).postMessage({ type: 'done', result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};

// 来源批次登记：文件哈希实算与声明比对、字段字典、修订管理。
// 批次行按 (batchId, revision) 不可变存储——运行中的任务天然继续引用启动快照。

import { db } from '../db/db';
import type { BatchMeta, FileDesc, TableRows, TableName, FieldDict } from '../domain/types';
import { TABLE_NAMES } from '../domain/types';
import { parseCsv } from '../domain/csv';
import { sha256Hex } from '../domain/hash';

export interface BatchFileInput {
  batchJson: string;   // batch.json 内容
  fieldsJson?: string; // fields.json 内容
  csvByTable: Partial<Record<TableName, { name: string; text: string }>>;
}

export async function registerBatch(input: BatchFileInput): Promise<{ ok: true; batch: BatchMeta } | { ok: false; error: string }> {
  let meta: { batchId: string; revision: number; declaredAt?: string; note?: string; changes?: string[]; files?: { name: string; table: TableName; sha256: string }[] };
  try {
    meta = JSON.parse(input.batchJson);
  } catch {
    return { ok: false, error: 'batch.json 解析失败' };
  }
  if (!meta.batchId || !meta.revision) return { ok: false, error: 'batch.json 缺少 batchId / revision' };
  const key = `${meta.batchId}@r${meta.revision}`;
  const existing = await db.batches.get(key);
  if (existing) {
    return { ok: false, error: `批次 ${key} 已登记（批次内容不可变，修订请以 r${meta.revision + 1} 重新登记）` };
  }

  const tables: TableRows = { events: [], dispatches: [], resources: [], arrivals: [], closures: [] };
  const files: FileDesc[] = [];
  for (const table of TABLE_NAMES) {
    const f = input.csvByTable[table];
    if (!f) return { ok: false, error: `缺少 ${table}.csv` };
    const hash = await sha256Hex(f.text);
    const declared = meta.files?.find((x) => x.table === table)?.sha256;
    const rows = parseCsv(f.text);
    (tables[table] as unknown[]) = rows;
    files.push({ name: f.name, table, sha256: hash, declaredSha256: declared, hashMatch: declared ? declared === hash : true, rows: rows.length });
  }

  let fieldDict: FieldDict | undefined;
  if (input.fieldsJson) {
    try {
      fieldDict = (JSON.parse(input.fieldsJson) as { tables: FieldDict }).tables;
    } catch { /* 字段字典可选 */ }
  }

  const batch: BatchMeta = {
    key,
    batchId: meta.batchId,
    revision: meta.revision,
    note: meta.note ?? '',
    declaredAt: meta.declaredAt ?? '',
    registeredAt: new Date().toISOString(),
    files,
    status: 'latest',
    changes: meta.changes ?? [],
    fieldDict
  };

  await db.transaction('rw', db.batches, db.batchRows, async () => {
    // 同 batchId 的旧修订标记为已被取代；若已存在更高修订，本批次登记即为历史修订
    const olds = await db.batches.where('batchId').equals(meta.batchId).toArray();
    const maxExisting = Math.max(0, ...olds.map((o) => o.revision));
    if (meta.revision < maxExisting) batch.status = 'superseded';
    for (const o of olds) {
      if (o.revision < meta.revision && o.status === 'latest') {
        await db.batches.update(o.key, { status: 'superseded' });
      }
    }
    await db.batches.put(batch);
    await db.batchRows.put({ key, tables });
  });
  return { ok: true, batch };
}

/** 从内置样例目录加载（/samples/emerg-2025-09/r1|r2） */
export async function loadBundledSample(revision: 1 | 2): Promise<{ ok: true; batch: BatchMeta } | { ok: false; error: string }> {
  const base = `${import.meta.env.BASE_URL}samples/emerg-2025-09/r${revision}`;
  const fetchText = async (name: string) => {
    const res = await fetch(`${base}/${name}`);
    if (!res.ok) throw new Error(`无法加载 ${name}: HTTP ${res.status}`);
    return res.text();
  };
  try {
    const [batchJson, fieldsJson, events, dispatches, resources, arrivals, closures] = await Promise.all([
      fetchText('batch.json'),
      fetchText('fields.json'),
      fetchText('events.csv'),
      fetchText('dispatches.csv'),
      fetchText('resources.csv'),
      fetchText('arrivals.csv'),
      fetchText('closures.csv')
    ]);
    return registerBatch({
      batchJson,
      fieldsJson,
      csvByTable: {
        events: { name: 'events.csv', text: events },
        dispatches: { name: 'dispatches.csv', text: dispatches },
        resources: { name: 'resources.csv', text: resources },
        arrivals: { name: 'arrivals.csv', text: arrivals },
        closures: { name: 'closures.csv', text: closures }
      }
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function getBatchRows(key: string): Promise<TableRows | undefined> {
  return (await db.batchRows.get(key))?.tables;
}

/** 源数据体检（信息性）：引用覆盖与明显时序异常，不阻断任何流程 */
export async function inspectBatch(key: string): Promise<string[]> {
  const rows = await getBatchRows(key);
  if (!rows) return ['批次数据缺失'];
  const issues: string[] = [];
  const dispatchIds = new Set(rows.dispatches.map((d) => d.dispatch_id));
  const arrDispatch = new Set(rows.arrivals.map((a) => a.dispatch_id));
  for (const d of rows.dispatches) {
    if (!arrDispatch.has(d.dispatch_id)) issues.push(`派遣 ${d.dispatch_id} 缺少到场记录`);
  }
  for (const a of rows.arrivals) {
    if (!dispatchIds.has(a.dispatch_id)) issues.push(`到场 ${a.arrival_id} 引用了不存在的派遣`);
  }
  const arriveByEvent = new Map<string, number>();
  const dispById = new Map(rows.dispatches.map((d) => [d.dispatch_id, d]));
  for (const a of rows.arrivals) {
    const d = dispById.get(a.dispatch_id);
    if (!d) continue;
    const t = new Date(a.arrive_time.replace(' ', 'T')).getTime();
    arriveByEvent.set(d.event_id, Math.max(arriveByEvent.get(d.event_id) ?? 0, t));
  }
  for (const c of rows.closures) {
    const last = arriveByEvent.get(c.event_id);
    if (last && new Date(c.close_time.replace(' ', 'T')).getTime() < last) {
      issues.push(`事件 ${c.event_id} 结案时间早于末次到场（待修订）`);
    }
  }
  return issues.length ? issues : ['未发现明显问题'];
}

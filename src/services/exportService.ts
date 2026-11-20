// 导出演练包：按方案声明的导出字段生成 CSV/JSON 并触发下载。

import type { TableRows, TableName, Plan } from '../domain/types';
import { TABLE_NAMES, TABLE_LABELS } from '../domain/types';
import { toCsv } from '../domain/csv';

function download(name: string, content: string, mime = 'text/plain'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportRunPackage(runSeq: number, tables: TableRows, exportFields: Record<TableName, string[]>): void {
  for (const t of TABLE_NAMES) {
    const csv = toCsv(tables[t] as unknown as Record<string, string>[], exportFields[t]);
    download(`run${String(runSeq).padStart(4, '0')}-${t}.csv`, csv, 'text/csv');
  }
}

export function exportJson(name: string, value: unknown): void {
  download(name, JSON.stringify(value, null, 2), 'application/json');
}

export { TABLE_LABELS };

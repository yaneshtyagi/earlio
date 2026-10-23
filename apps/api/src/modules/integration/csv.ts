/** Minimal RFC-4180 reader/writer for the bank file-drop fallback. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((c) => c.trim() !== '')) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some((c) => c.trim() !== '')) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  const keys = head.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

/** Cells that start with a formula character are prefixed so spreadsheets cannot execute them. */
const safe = (v: unknown) => { const s = v == null ? '' : String(v); const t = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s; return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => safe(r[c])).join(','))].join('\r\n') + '\r\n';
}

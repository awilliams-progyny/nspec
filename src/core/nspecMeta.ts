import type { Stage } from './specStore';

export interface ParsedNspecMeta {
  hasMeta: boolean;
  meta: Record<string, string>;
  body: string;
}

const NSPEC_HEADER_RE = /^\uFEFF?\s*<!--\s*nspec:\s*([\s\S]*?)-->\s*/i;

function parseMetaBody(raw: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim().toLowerCase();
    const value = trimmed.slice(idx + 1).trim();
    if (!key) continue;
    meta[key] = value;
  }
  return meta;
}

function formatMetaHeader(meta: Record<string, string>): string {
  const orderedKeys = ['stage', 'step_id', 'done'];
  const lines: string[] = [];
  for (const key of orderedKeys) {
    const value = meta[key];
    if (value !== undefined && value !== '') {
      lines.push(`${key}: ${value}`);
    }
  }
  for (const key of Object.keys(meta).sort()) {
    if (orderedKeys.includes(key)) continue;
    const value = meta[key];
    if (value !== undefined && value !== '') {
      lines.push(`${key}: ${value}`);
    }
  }
  return `<!-- nspec:\n${lines.join('\n')}\n-->`;
}

export function parseNspecMeta(markdown: string): ParsedNspecMeta {
  const source = markdown ?? '';
  const match = source.match(NSPEC_HEADER_RE);
  if (!match) {
    return { hasMeta: false, meta: {}, body: source };
  }

  const rawMetaBody = match[1] ?? '';
  const meta = parseMetaBody(rawMetaBody);
  const body = source.slice(match[0].length);
  return { hasMeta: true, meta, body };
}

export function upsertNspecMeta(markdown: string, meta: Record<string, string>): string {
  const parsed = parseNspecMeta(markdown);
  const nextMeta = { ...parsed.meta, ...meta };
  const header = formatMetaHeader(nextMeta);
  const body = parsed.body ?? '';
  if (!body.trim()) return `${header}\n`;
  return `${header}\n\n${body.replace(/^\n+/, '')}`;
}

export function makeStepId(stage: Stage): string {
  const nonce = Math.random().toString(36).slice(2, 8);
  return `${stage}-${Date.now().toString(36)}-${nonce}`;
}

export function isDone(meta: Record<string, string>): boolean {
  return (meta.done ?? '').trim().toLowerCase() === 'true';
}

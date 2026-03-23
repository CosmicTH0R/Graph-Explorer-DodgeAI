/**
 * Utility functions for the LLM chat pipeline.
 * Extracted here so they can be unit-tested independently of Next.js API routes.
 */

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compactValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return `[array:${value.length}]`;
  if (typeof value === 'object') {
    if (depth > 0) return '[object]';
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, compactValue(v, depth + 1)])
    );
  }
  return value;
}

export function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, compactValue(value)])
  );
}

export function getMentionCandidates(properties: Record<string, unknown>): string[] {
  const candidates = new Set<string>();

  for (const [key, value] of Object.entries(properties)) {
    if (value == null || Array.isArray(value) || typeof value === 'object') continue;
    const text = String(value).trim();
    if (!text) continue;

    if (
      key === 'id' ||
      key === 'code' ||
      key.endsWith('Id') ||
      key.endsWith('Code') ||
      key.endsWith('Document') ||
      key === 'name' ||
      /^[A-Z0-9_-]{4,}$/.test(text)
    ) {
      candidates.add(text);
    }
  }

  return Array.from(candidates);
}

export const FORBIDDEN_PATTERNS = [
  /\bCREATE\b/,
  /\bDELETE\b/,
  /\bMERGE\b/,
  /\bSET\b/,
  /\bREMOVE\b/,
  /\bDROP\b/,
  /\bDETACH\b/,
  /\bFOREACH\b/,
  /CALL\s+APOC/,
  /LOAD\s+CSV/,
  /CALL\s*\{/,
];

export function isMutatingCypher(query: string): boolean {
  return FORBIDDEN_PATTERNS.some(re => re.test(query.toUpperCase()));
}

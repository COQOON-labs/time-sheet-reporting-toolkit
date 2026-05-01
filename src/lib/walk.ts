/**
 * Generic JSON tree walker. Replaces ad-hoc walk-* helpers across the
 * extension. Yields every plain object encountered (recursively) and lets
 * the caller decide what to do with it.
 *
 * `depth` is bounded; cycles are detected via a WeakSet.
 */

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export type Visitor = (obj: Record<string, unknown>, path: string) => void;

export function walkObjects(
  root: unknown,
  visit: Visitor,
  opts: { maxDepth?: number } = {},
): void {
  const maxDepth = opts.maxDepth ?? 10;
  const seen = new WeakSet<object>();
  const go = (v: unknown, path: string, depth: number): void => {
    if (depth > maxDepth || v == null) return;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) go(v[i], `${path}[${i}]`, depth + 1);
      return;
    }
    if (!isPlainObject(v)) return;
    if (seen.has(v)) return;
    seen.add(v);
    visit(v, path);
    for (const k of Object.keys(v)) go(v[k], path ? `${path}.${k}` : k, depth + 1);
  };
  go(root, '', 0);
}

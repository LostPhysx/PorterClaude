// FROZEN (planner-authored, fully implemented). Naming rules shared by sessions/terminals/images.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** Lowercase, dash-separated, docker-name-safe. Throws if nothing usable remains. */
export function toSlug(input: string): string {
  const s = input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 31);
  if (!s || !SLUG_RE.test(s)) throw new Error(`cannot derive a valid slug from ${JSON.stringify(input)}`);
  return s;
}

export function isSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

/** tmux session names may not contain '.' or ':'; keep them short and boring. */
export function tmuxSessionName(terminalName: string): string {
  const base = terminalName.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'main';
  return `pc_${base}`;
}

/** Single-quote a string for safe interpolation into `sh -lc '...'`. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\''`)}'`;
}

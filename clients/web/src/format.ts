// Shared display formatters. Kept in one place so the sub-cent cost convention can't drift
// between the chat footer and the /debug ledger (both render the same kind of figure).

// USD cost, trailing-zero-trimmed so sub-cent costs stay legible (e.g. $0.0012) without padding
// every value to 6 decimals. Accepts a numeric string (the DB stores cost_usd as a string), a
// number (a footer total summed in JS), or null. null/non-finite → '—'; exactly zero → '$0'.
export function usd(v: string | number | null): string {
  if (v == null) return '—'
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '$0'
  return '$' + n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

// Compact token count for the chat footer: ≥1000 → one-decimal 'k' (12.4k), else the integer.
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

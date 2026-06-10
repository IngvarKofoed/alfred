// The chrome-mcp MCP server truncated large results at 100k chars; dropping that layer
// (Option C) would let a huge page flood the model's context and cost. Re-apply it here —
// for bare strings (get_page_text/html, python stdout/stderr) and for large structured
// results (e.g. get_links on a link-heavy page, which returns an array), matching chrome-mcp
// which truncated the JSON. Shared by the browser and python tools.
export const MAX_RESULT_CHARS = 100_000
const TRUNCATION_NOTE = `\n\n[truncated: result exceeded ${MAX_RESULT_CHARS} characters]`

export function capResult(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_RESULT_CHARS ? value.slice(0, MAX_RESULT_CHARS) + TRUNCATION_NOTE : value
  }
  // Non-string: only large structured results need capping. Serialize to measure; on
  // overflow return the truncated JSON (the model still gets a readable, bounded result).
  const json = JSON.stringify(value)
  if (typeof json === 'string' && json.length > MAX_RESULT_CHARS) {
    return json.slice(0, MAX_RESULT_CHARS) + TRUNCATION_NOTE
  }
  return value
}

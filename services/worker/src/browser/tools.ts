import type { Tool } from '@alfred/agent-core'
import type { BrowserBridge } from './bridge.js'

// The chrome-mcp MCP server truncated large results at 100k chars; dropping that layer
// (Option C) would let a huge page flood the model's context and cost. Re-apply it here —
// for bare strings (get_page_text/html) and for large structured results (e.g. get_links on
// a link-heavy page, which returns an array), matching chrome-mcp which truncated the JSON.
const MAX_RESULT_CHARS = 100_000
const TRUNCATION_NOTE = `\n\n[truncated: result exceeded ${MAX_RESULT_CHARS} characters]`

function capResult(value: unknown): unknown {
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

interface Spec {
  name: string
  description: string
  inputSchema: object
}

// Every browser tool is `write` tier to start (spec decision): each action — including reads —
// pauses for owner approval through the existing gate. Deliberately conservative; a later
// refinement can demote pure-reads to `read` and/or promote evaluate_javascript to `destructive`.
const OBJECT = (properties: Record<string, object> = {}, required: string[] = []): object => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
})

const STR = (description: string) => ({ type: 'string', description })
const NUM = (description: string) => ({ type: 'number', description })

const SPECS: Spec[] = [
  // Navigation
  { name: 'navigate', description: 'Navigate to a URL in the active tab', inputSchema: OBJECT({ url: STR('The URL to navigate to') }, ['url']) },
  { name: 'go_back', description: 'Go back in browser history', inputSchema: OBJECT() },
  { name: 'go_forward', description: 'Go forward in browser history', inputSchema: OBJECT() },
  { name: 'reload', description: 'Reload the current page', inputSchema: OBJECT() },
  { name: 'get_current_url', description: 'Get the URL and title of the active tab', inputSchema: OBJECT() },
  // Tabs
  { name: 'list_tabs', description: 'List all open tabs with their IDs, titles, and URLs', inputSchema: OBJECT() },
  { name: 'switch_tab', description: 'Switch to a specific tab by its ID', inputSchema: OBJECT({ tabId: NUM('The ID of the tab to switch to') }, ['tabId']) },
  { name: 'open_tab', description: 'Open a new tab, optionally with a URL', inputSchema: OBJECT({ url: STR('URL to open in the new tab. If omitted, opens a blank tab.') }) },
  { name: 'close_tab', description: 'Close a tab by its ID. If no ID is given, closes the active tab.', inputSchema: OBJECT({ tabId: NUM('The ID of the tab to close. If omitted, closes the active tab.') }) },
  // Page content
  { name: 'get_page_text', description: 'Get the visible text content of the current page', inputSchema: OBJECT() },
  { name: 'get_page_html', description: 'Get the HTML of the page or a specific element', inputSchema: OBJECT({ selector: STR('CSS selector of the element. If omitted, returns the full page HTML.') }) },
  { name: 'get_page_title', description: 'Get the title of the current page', inputSchema: OBJECT() },
  { name: 'get_links', description: 'Get all links on the page with their text and URLs', inputSchema: OBJECT() },
  { name: 'get_headings', description: 'Get the heading structure of the page (h1-h6)', inputSchema: OBJECT() },
  // Interaction
  { name: 'click', description: 'Click an element identified by CSS selector', inputSchema: OBJECT({ selector: STR('CSS selector of the element to click') }, ['selector']) },
  {
    name: 'type_text',
    description: 'Type text into an input field identified by CSS selector',
    inputSchema: OBJECT(
      {
        selector: STR('CSS selector of the input field'),
        text: STR('Text to type into the field'),
        clearFirst: { type: 'boolean', description: 'Whether to clear the field before typing. Defaults to true.' },
      },
      ['selector', 'text'],
    ),
  },
  { name: 'select_option', description: 'Select an option from a dropdown by CSS selector and value', inputSchema: OBJECT({ selector: STR('CSS selector of the select element'), value: STR('Value of the option to select') }, ['selector', 'value']) },
  {
    name: 'scroll',
    description: 'Scroll the page in a given direction',
    inputSchema: OBJECT(
      {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Direction to scroll' },
        amount: NUM('Amount to scroll in pixels. Defaults to one viewport height/width.'),
      },
      ['direction'],
    ),
  },
  { name: 'hover', description: 'Hover over an element identified by CSS selector', inputSchema: OBJECT({ selector: STR('CSS selector of the element to hover over') }, ['selector']) },
  // Page query
  {
    name: 'query_selector',
    description: 'Find elements matching a CSS selector and return their text and attributes',
    inputSchema: OBJECT(
      {
        selector: STR('CSS selector to query'),
        attributes: { type: 'array', items: { type: 'string' }, description: 'Attribute names to include. Defaults to id, class, href, src, type, value, name.' },
      },
      ['selector'],
    ),
  },
  { name: 'evaluate_javascript', description: 'Execute JavaScript in the page context and return the result', inputSchema: OBJECT({ expression: STR('JavaScript expression to evaluate in the page context') }, ['expression']) },
  { name: 'get_form_fields', description: 'Get all form fields on the page with their current values, types, and labels', inputSchema: OBJECT() },
]

// Adapt each browser command to the agent-core Tool interface (ARCHITECTURE §7.3): a built-in
// tool whose invoke() proxies to the extension over the embedded bridge. No MCP involved.
export function makeBrowserTools(bridge: BrowserBridge): Tool[] {
  return SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    trustTier: 'write',
    // All browser tools are one unit: a single per-run approval covers the whole task
    // (ARCHITECTURE §16), instead of prompting per click/type.
    group: 'browser',
    async invoke(args: unknown): Promise<unknown> {
      const result = await bridge.sendCommand(spec.name, (args ?? {}) as Record<string, unknown>)
      return capResult(result)
    },
  }))
}

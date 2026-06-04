// Wire protocol between the worker's BrowserBridge and the Chrome extension over the
// WebSocket. Deliberately duplicated in chrome-extension/src/types.ts (the extension is a
// browser/esbuild build that can't import from this Node package) — keep the two in sync.

export interface WebSocketRequest {
  id: string
  command: string
  params: Record<string, unknown>
}

export interface WebSocketResponse {
  id: string
  success: boolean
  data?: unknown
  error?: string
}

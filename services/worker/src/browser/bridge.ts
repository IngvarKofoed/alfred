import { randomUUID } from 'node:crypto'
import { loadConfig } from '@alfred/shared'
import { WebSocket, WebSocketServer } from 'ws'
import type { WebSocketRequest, WebSocketResponse } from './types.js'

// How long a single browser command may take before we give up on it (ARCHITECTURE §10.7
// lists 30s as the browser-action default).
const COMMAND_TIMEOUT_MS = 30_000

// The WebSocket server the Chrome extension connects to. Lifted from the owner's chrome-mcp
// project (`websocket-bridge.ts`) and embedded directly in alfred-worker — there is no
// separate bridge process and no MCP (ARCHITECTURE §8, Option C). Two containment changes
// over the original:
//   1. bind to 127.0.0.1 so other devices on the network can't reach it;
//   2. accept a connection only if its Origin is `chrome-extension://…` — a webpage you
//      visit can open a localhost WebSocket but cannot forge that origin, which closes the
//      drive-by-impersonation hole the original left open.
export class BrowserBridge {
  private wss: WebSocketServer | null = null
  private client: WebSocket | null = null
  private pendingRequests = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private readonly port: number

  constructor(port: number) {
    this.port = port
  }

  get isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN
  }

  start(): void {
    if (this.wss) return
    this.wss = new WebSocketServer({
      host: '127.0.0.1',
      port: this.port,
      // Only the extension may connect: a webpage's WebSocket carries its own
      // https:// origin and can't spoof chrome-extension:// (ARCHITECTURE §8).
      verifyClient: ({ origin }: { origin?: string }) =>
        typeof origin === 'string' && origin.startsWith('chrome-extension://'),
    })

    // Best-effort: a listen failure (e.g. EADDRINUSE when the port is taken by a stale
    // worker during a pm2-reload overlap, or a second worker — §7.4) must NOT crash the
    // worker and take down agent-run consumption. The browser tools just stay unavailable
    // (sendCommand throws 'not connected') until a bridge is up.
    this.wss.on('error', (err: NodeJS.ErrnoException) => {
      console.error(`[browser-bridge] server error (browser tools unavailable in this worker): ${err.message}`)
    })
    this.wss.on('listening', () => console.log(`[browser-bridge] listening on ws://127.0.0.1:${this.port}`))

    this.wss.on('connection', (ws) => {
      // One extension at a time; a fresh connection replaces a stale one. Abort any command
      // still outstanding on the old socket so the run fails fast instead of waiting out the
      // 30s timeout (MV3 service-worker suspension makes reconnects routine — §8).
      if (this.client) {
        console.log('[browser-bridge] replacing existing extension connection')
        this.rejectAllPending(new Error('Chrome extension reconnected; in-flight browser command aborted'))
        this.client.close()
      }
      this.client = ws
      console.log('[browser-bridge] extension connected')

      ws.on('message', (raw) => {
        try {
          this.handleResponse(JSON.parse(raw.toString()) as WebSocketResponse)
        } catch (err) {
          console.error('[browser-bridge] failed to parse message:', err)
        }
      })
      ws.on('close', () => {
        if (this.client === ws) {
          this.client = null
          this.rejectAllPending(new Error('Chrome extension disconnected; in-flight browser command aborted'))
          console.log('[browser-bridge] extension disconnected')
        }
      })
      ws.on('error', (err) => console.error('[browser-bridge] websocket error:', err.message))
    })
  }

  // Fail every outstanding command (on disconnect, reconnect, or shutdown) instead of
  // letting it hang until its per-command timeout.
  private rejectAllPending(reason: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.pendingRequests.clear()
  }

  // Send one command to the extension and await its response (or time out). Throws if no
  // extension is connected — the agent loop turns that into a tool error the model reads.
  async sendCommand(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.isConnected) {
      throw new Error('Chrome extension is not connected. Make sure Chrome is running with the Alfred extension loaded.')
    }

    const id = randomUUID()
    const request: WebSocketRequest = { id, command, params }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Browser command '${command}' timed out after ${COMMAND_TIMEOUT_MS}ms`))
      }, COMMAND_TIMEOUT_MS)
      this.pendingRequests.set(id, { resolve, reject, timer })
      this.client!.send(JSON.stringify(request))
    })
  }

  private handleResponse(msg: WebSocketResponse): void {
    const pending = this.pendingRequests.get(msg.id)
    if (!pending) return // unknown id (e.g. the extension's keepalive ping)
    clearTimeout(pending.timer)
    this.pendingRequests.delete(msg.id)
    if (msg.success) pending.resolve(msg.data)
    else pending.reject(new Error(msg.error ?? 'Unknown error from extension'))
  }

  stop(): void {
    this.rejectAllPending(new Error('Browser bridge shutting down'))
    this.client?.close()
    this.client = null
    this.wss?.close()
    this.wss = null
    console.log('[browser-bridge] stopped')
  }
}

// Process-wide singleton. Constructing it is side-effect-free (no server until start()),
// so importing this from the tool factory during a run is safe even in tests.
let singleton: BrowserBridge | null = null

export function getBridge(): BrowserBridge {
  if (!singleton) singleton = new BrowserBridge(loadConfig().BRIDGE_WS_PORT)
  return singleton
}

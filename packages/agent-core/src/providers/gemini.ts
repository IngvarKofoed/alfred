import { loadConfig } from '@alfred/shared'
import { type Content, type FunctionDeclaration, GoogleGenAI, type Part } from '@google/genai'
import type { LlmProvider, StreamOptions } from '../provider.js'
import type { Tool } from '../tool.js'
import type { Message, StreamEvent } from '../types.js'

// GeminiProvider — the first concrete LlmProvider, on Google's @google/genai SDK.
// It translates our provider-agnostic Message[] <-> Gemini contents, our Tool[] ->
// functionDeclarations, and Gemini's streamed text/functionCall chunks -> StreamEvents.
export class GeminiProvider implements LlmProvider {
  private readonly ai: GoogleGenAI
  private readonly defaultModel: string

  constructor(opts?: { apiKey?: string; model?: string }) {
    const config = loadConfig()
    const apiKey = opts?.apiKey ?? config.GEMINI_API_KEY
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set — required for the Gemini provider')
    }
    this.ai = new GoogleGenAI({ apiKey })
    this.defaultModel = opts?.model ?? config.GEMINI_MODEL
  }

  async *stream(
    messages: Message[],
    tools: Tool[],
    opts?: StreamOptions,
  ): AsyncIterable<StreamEvent> {
    const model = opts?.model ?? this.defaultModel
    const systemInstruction = systemText(messages)
    const functionDeclarations = tools.map(toFunctionDeclaration)

    try {
      const response = await this.ai.models.generateContentStream({
        model,
        contents: toGeminiContents(messages),
        config: {
          // Abort is client-side only (per the SDK docs): it stops us reading the stream,
          // not Google's generation — partially generated tokens may still be billed.
          ...(opts?.signal ? { abortSignal: opts.signal } : {}),
          ...(systemInstruction ? { systemInstruction } : {}),
          ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
        },
      })

      // Gemini function calls carry no stable id; synthesize one per call for our model.
      let callIndex = 0
      let promptTokens: number | undefined
      let cachedTokens: number | undefined
      let completionTokens: number | undefined
      let finishReason: string | undefined
      for await (const chunk of response) {
        // Read the parts array directly rather than the chunk.text / chunk.functionCalls
        // getters: the .text getter warns ("non-text parts functionCall in the response…")
        // whenever a chunk carries both text and a function call, which is routine. Walking
        // parts ourselves yields the same text+calls without the spurious warning. Skip
        // `thought` parts, matching the .text getter.
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (typeof part.text === 'string' && part.text && !part.thought) {
            yield { type: 'text', text: part.text }
          }
          const call = part.functionCall
          if (call) {
            yield {
              type: 'tool_call',
              id: call.id ?? `${call.name}-${callIndex++}`,
              name: call.name ?? '',
              args: call.args ?? {},
            }
          }
        }
        if (chunk.usageMetadata) {
          promptTokens = chunk.usageMetadata.promptTokenCount ?? promptTokens
          // promptTokenCount is the TOTAL input incl. cached; this is the cached subset.
          cachedTokens = chunk.usageMetadata.cachedContentTokenCount ?? cachedTokens
          completionTokens = chunk.usageMetadata.candidatesTokenCount ?? completionTokens
        }
        const fr = chunk.candidates?.[0]?.finishReason
        if (fr) finishReason = String(fr)
      }

      yield { type: 'usage', model, promptTokens, cachedTokens, completionTokens, finishReason }
    } catch (err) {
      throw translateGeminiError(err)
    }
  }
}

// Node's fetch throws `TypeError: fetch failed` with the real cause nested in `err.cause`
// (a DNS/connection error carrying a `.code`). The bare "fetch failed" that otherwise
// reaches the owner via agent_runs.error / the NOTIFY error event is useless — translate
// the common offline/unreachable cases into something actionable. Anything we don't
// recognize is rethrown untouched so genuine API errors (4xx/5xx) keep their own message.
export function translateGeminiError(err: unknown): unknown {
  if (!(err instanceof Error)) return err
  // An aborted request (the run was cancelled, §10.6) is not a connectivity failure — pass
  // it through untouched so it is never rewritten into the offline message. The worker
  // classifies cancels by its own AbortController's signal, never by error shape.
  if (err.name === 'AbortError') return err
  const cause = (err as { cause?: unknown }).cause
  const code =
    cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : undefined

  // The network-layer failure modes of Node's undici fetch.
  const offlineCodes = new Set([
    'ENOTFOUND', // DNS lookup failed — no internet, or DNS down
    'EAI_AGAIN', // DNS temporary failure — usually no internet
    'ECONNREFUSED', // connection refused
    'ECONNRESET', // connection dropped mid-flight
    'ETIMEDOUT', // connection timed out
    'EHOSTUNREACH', // no route to host
    'ENETUNREACH', // network unreachable
    'UND_ERR_CONNECT_TIMEOUT', // undici connect timeout
  ])

  // When the cause carries a code, trust it (rewrite only recognized offline codes) — so a
  // `fetch failed` with an unrecognized code (e.g. a TLS CERT_HAS_EXPIRED) is NOT mislabeled
  // as a connectivity problem. Fall back to the bare-message match only when there's no code.
  const isOffline = code ? offlineCodes.has(code) : err.message === 'fetch failed'
  if (isOffline) {
    const detail = code ? ` (${code})` : ''
    return new Error(
      `Couldn't reach the Gemini API — check your internet connection and try again${detail}.`,
      { cause: err },
    )
  }
  return err
}

function systemText(messages: Message[]): string | undefined {
  const text = messages
    .filter((m) => m.role === 'system')
    .flatMap((m) => m.content)
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n')
    .trim()
  return text || undefined
}

export function toGeminiContents(messages: Message[]): Content[] {
  const contents: Content[] = []
  for (const m of messages) {
    if (m.role === 'system') continue

    if (m.role === 'tool') {
      // functionResponse parts must travel in their own Content — Gemini rejects a Content
      // that mixes functionResponse with inlineData. Any image a tool returned (e.g. a
      // screenshot) follows as a SEPARATE user turn so the model still sees it.
      const fnParts: Part[] = []
      const imageParts: Part[] = []
      for (const p of m.content) {
        if (p.type === 'tool_result')
          fnParts.push({ functionResponse: { name: p.name, response: asRecord(p.result) } })
        else if (p.type === 'image')
          imageParts.push({ inlineData: { mimeType: p.mimeType, data: p.data } })
      }
      if (fnParts.length) contents.push({ role: 'user', parts: fnParts })
      if (imageParts.length) contents.push({ role: 'user', parts: imageParts })
      continue
    }

    const parts: Part[] = []
    for (const p of m.content) {
      if (p.type === 'text') parts.push({ text: p.text })
      else if (p.type === 'tool_use') parts.push({ functionCall: { name: p.name, args: asRecord(p.args) } })
      else if (p.type === 'image') parts.push({ inlineData: { mimeType: p.mimeType, data: p.data } })
    }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts })
  }
  return contents
}

function toFunctionDeclaration(tool: Tool): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as unknown as FunctionDeclaration['parameters'],
  }
}

// Gemini's functionResponse.response / functionCall.args are proto Structs — they MUST
// be a JSON object. typeof [] === 'object', so an array (a tool returning a list, e.g.
// get_links/list_tabs) would otherwise be sent as a Struct-that-starts-with-a-list and
// the API rejects the whole request ("Proto field is not repeating, cannot start list").
// Wrap arrays (and primitives/null) under a `value` key so the payload is always a Struct.
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value }
}

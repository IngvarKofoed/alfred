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

    const response = await this.ai.models.generateContentStream({
      model,
      contents: toGeminiContents(messages),
      config: {
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
      const text = chunk.text
      if (text) yield { type: 'text', text }
      for (const call of chunk.functionCalls ?? []) {
        yield {
          type: 'tool_call',
          id: call.id ?? `${call.name}-${callIndex++}`,
          name: call.name ?? '',
          args: call.args ?? {},
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
  }
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
      const parts: Part[] = m.content
        .filter((p) => p.type === 'tool_result')
        .map((p) => ({ functionResponse: { name: p.name, response: asRecord(p.result) } }))
      contents.push({ role: 'user', parts })
      continue
    }

    const parts: Part[] = []
    for (const p of m.content) {
      if (p.type === 'text') parts.push({ text: p.text })
      else if (p.type === 'tool_use') parts.push({ functionCall: { name: p.name, args: asRecord(p.args) } })
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

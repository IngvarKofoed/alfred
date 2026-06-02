import type { Tool } from './tool.js'
import type { Message, StreamEvent } from './types.js'

export interface StreamOptions {
  model?: string
  signal?: AbortSignal
}

// The one interface every LLM vendor lives behind (ARCHITECTURE §7.2). Swapping
// providers is a config/construction choice, never a change to the loop.
export interface LlmProvider {
  stream(messages: Message[], tools: Tool[], opts?: StreamOptions): AsyncIterable<StreamEvent>
}

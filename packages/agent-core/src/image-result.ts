// The marker a tool returns when its result is an image (a screenshot, a generated image,
// an image file read off disk). The loop detects it via isImageResult and turns it into a
// short text ack for the model's functionResponse (which can't carry an image) PLUS an
// `image` ContentPart on the same tool turn, so the model actually sees the image. The
// worker (which owns the conversation id) persists the bytes to the workspace and stores
// only a reference in tool_calls.result — base64 never lands in Postgres. One source of
// truth: both the loop and the worker import these.
export interface ImageToolResult {
  image: { mimeType: string; data: string }
  summary?: string
}

export function isImageResult(value: unknown): value is ImageToolResult {
  if (value === null || typeof value !== 'object') return false
  const image = (value as { image?: unknown }).image
  if (image === null || typeof image !== 'object') return false
  const { mimeType, data } = image as { mimeType?: unknown; data?: unknown }
  return typeof mimeType === 'string' && typeof data === 'string'
}

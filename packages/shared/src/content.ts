// Join the text of a message's content parts into one string. The single place "concatenate the
// text parts of a (possibly jsonb) message content" lives — used by the worker's textOf and the
// db readLastAssistantText, so a future text-bearing part type is handled in one spot rather than
// drifting between copies. Defensive: a non-array content, or a non-text/malformed part, contributes
// nothing (matches both prior open-coded copies, which concatenate text parts with no separator).
export function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((p) =>
      p &&
      typeof p === 'object' &&
      (p as { type?: unknown }).type === 'text' &&
      typeof (p as { text?: unknown }).text === 'string'
        ? (p as { text: string }).text
        : '',
    )
    .join('')
}

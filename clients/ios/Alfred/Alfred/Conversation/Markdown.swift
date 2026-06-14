//
//  Markdown.swift
//  Alfred
//
//  One shared inline-markdown renderer used by both the durable assistant bubble
//  (MessageView, via ChatMessage.renderedText) and the live block (ConversationView), so the
//  two can't visually diverge. Inline-only (emphasis, links, inline code); block constructs
//  degrade to text for the MVP (per spec). Falls back to the raw string if it doesn't parse.
//

import Foundation

nonisolated func inlineMarkdown(_ text: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .inlineOnlyPreservingWhitespace
    )
    return (try? AttributedString(markdown: text, options: options))
        ?? AttributedString(text)
}

//
//  MessageView.swift
//  Alfred
//
//  A single durable message bubble in the transcript. User messages are right-aligned
//  with a tinted bubble; assistant messages are left-aligned with markdown-rendered text,
//  inline image thumbnails (served from /media), and quiet tool chips. System lines (e.g.
//  a local error note) render centered and muted.
//

import SwiftUI

struct MessageView: View {
    let message: ChatMessage
    /// Resolves an image part's workspace-relative path to an absolute /media URL.
    let mediaURL: (String) -> URL?
    /// Whether to show the "ALFRED" label. True only on the first assistant bubble in a
    /// contiguous run of Alfred output, so a sequence of tool + text turns isn't labeled over
    /// and over (mirrors the web client's `showName`). Defaults true for standalone use.
    var showName: Bool = true

    // Precomputed on the ChatMessage at construction (no per-render recompute / re-parse).
    private var text: String { message.text }
    private var images: [Attachment] { message.images }
    private var toolUses: [ToolUse] { message.toolUses }

    var body: some View {
        switch message.role {
        case "user":
            userBubble
        case "system":
            systemLine
        case "tool":
            // A tool-result message is shown only when it carries an image (a screenshot or
            // generated image); a text-only tool result is surfaced via the assistant's chip.
            if images.isEmpty {
                EmptyView()
            } else {
                assistantBubble
            }
        default:
            assistantBubble
        }
    }

    // MARK: - User

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 40)
            VStack(alignment: .trailing, spacing: 8) {
                imageThumbnails(alignment: .trailing)
                if !text.isEmpty {
                    Text(text)
                        .textSelection(.enabled)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(Color.accentColor.opacity(0.18))
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }
        }
    }

    // MARK: - Assistant / tool

    @ViewBuilder
    private var assistantBubble: some View {
        // Nothing to show for an empty assistant turn (e.g. a tool-only turn already
        // surfaced elsewhere).
        if text.isEmpty && images.isEmpty && toolUses.isEmpty {
            EmptyView()
        } else {
            HStack {
                VStack(alignment: .leading, spacing: 8) {
                    if showName {
                        Text("ALFRED")
                            .font(.caption2.weight(.semibold))
                            .tracking(1.5)
                            .foregroundStyle(.tertiary)
                    }
                    if !text.isEmpty {
                        Text(message.renderedText)
                            .textSelection(.enabled)
                    }
                    imageThumbnails(alignment: .leading)
                    if !toolUses.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(toolUses, id: \.id) { tool in
                                ToolChip(name: tool.name, args: tool.args)
                            }
                        }
                    }
                }
                Spacer(minLength: 40)
            }
        }
    }

    // MARK: - System

    private var systemLine: some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, alignment: .center)
    }

    // MARK: - Images

    @ViewBuilder
    private func imageThumbnails(alignment: HorizontalAlignment) -> some View {
        if !images.isEmpty {
            VStack(alignment: alignment, spacing: 8) {
                ForEach(images, id: \.path) { img in
                    if let url = mediaURL(img.path) {
                        AsyncImage(url: url) { phase in
                            switch phase {
                            case .success(let image):
                                image
                                    .resizable()
                                    .scaledToFit()
                            case .failure:
                                Image(systemName: "photo")
                                    .foregroundStyle(.secondary)
                                    .frame(width: 80, height: 80)
                            default:
                                ProgressView()
                                    .frame(width: 80, height: 80)
                            }
                        }
                        .frame(maxWidth: 220, maxHeight: 220)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
            }
        }
    }

}

/// A single tool chip: a brass dot, the tool name, and a compact args summary.
/// Shared across the durable transcript (MessageView) and the live block (ConversationView).
struct ToolChip: View {
    let name: String
    let args: JSONValue?
    var live: Bool = false

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(Color.accentColor)
                .frame(width: 6, height: 6)
                .opacity(live ? 0.5 : 1)
            Text(name)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            if let summary = args?.summary, !summary.isEmpty {
                Text(summary)
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            if live {
                ProgressView()
                    .controlSize(.mini)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(.quaternary, in: Capsule())
    }
}

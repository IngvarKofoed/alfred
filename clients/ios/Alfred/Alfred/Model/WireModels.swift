//
//  WireModels.swift
//  Alfred
//
//  Codable mirrors of the alfred-webserver wire shapes. Most fields are camelCase;
//  the interaction prompt/response shapes are snake_case (matching DATABASE.md), so
//  those carry explicit CodingKeys.
//

import Foundation

// MARK: - Attachments & content parts

nonisolated struct Attachment: Codable, Hashable {
    let path: String
    let mimeType: String
}

/// One element of a message's `content` jsonb array. A single struct covers every
/// part variant (text / image / tool_use / tool_result); only the fields relevant to
/// the part's `type` are populated.
nonisolated struct ContentPart: Decodable, Hashable {
    let type: String
    let text: String?
    let name: String?
    let id: String?
    let args: JSONValue?
    let path: String?
    let mimeType: String?
}

/// Concatenate the text of every `text` part, in order.
nonisolated func textOf(_ parts: [ContentPart]) -> String {
    parts
        .filter { $0.type == "text" }
        .compactMap { $0.text }
        .joined()
}

/// The image attachments referenced by `image` parts.
nonisolated func imagesOf(_ parts: [ContentPart]) -> [Attachment] {
    parts.compactMap { part in
        guard part.type == "image", let path = part.path else { return nil }
        return Attachment(path: path, mimeType: part.mimeType ?? "image/jpeg")
    }
}

nonisolated struct ToolUse: Hashable {
    let id: String
    let name: String
    let args: JSONValue?
}

/// The `tool_use` parts of a message (the tools the assistant invoked this turn).
nonisolated func toolUsesOf(_ parts: [ContentPart]) -> [ToolUse] {
    parts.compactMap { part in
        guard part.type == "tool_use" else { return nil }
        return ToolUse(
            id: part.id ?? UUID().uuidString,
            name: part.name ?? "tool",
            args: part.args
        )
    }
}

// MARK: - Messages

nonisolated struct ChatMessage: Identifiable, Hashable {
    let id: String
    let role: String
    let content: [ContentPart]
    /// Derived once at construction so MessageView doesn't recompute / re-parse per render.
    let text: String
    let images: [Attachment]
    let toolUses: [ToolUse]
    /// The inline-markdown rendering of `text` for assistant turns (rendered once here, not on
    /// every body evaluation). Equatable/Hashable on the source `text` keeps ChatMessage stable.
    let renderedText: AttributedString

    init(id: String, role: String, content: [ContentPart]) {
        self.id = id
        self.role = role
        self.content = content
        self.text = textOf(content)
        self.images = imagesOf(content)
        self.toolUses = toolUsesOf(content)
        self.renderedText = inlineMarkdown(self.text)
    }

    init(from wire: WireMessage) {
        self.init(id: wire.id ?? UUID().uuidString, role: wire.role, content: wire.content)
    }

    static func == (lhs: ChatMessage, rhs: ChatMessage) -> Bool {
        lhs.id == rhs.id && lhs.role == rhs.role && lhs.content == rhs.content
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
        hasher.combine(role)
        hasher.combine(content)
    }

    /// Build an optimistic local user message (rendered immediately, before the POST
    /// round-trip), from typed text and/or uploaded attachments.
    static func optimisticUser(text: String?, attachments: [Attachment]) -> ChatMessage {
        var parts: [ContentPart] = []
        if let text, !text.isEmpty {
            parts.append(ContentPart(
                type: "text", text: text, name: nil, id: nil,
                args: nil, path: nil, mimeType: nil
            ))
        }
        for a in attachments {
            parts.append(ContentPart(
                type: "image", text: nil, name: nil, id: nil,
                args: nil, path: a.path, mimeType: a.mimeType
            ))
        }
        return ChatMessage(id: UUID().uuidString, role: "user", content: parts)
    }
}

nonisolated struct WireMessage: Decodable {
    let id: String?
    let role: String
    let content: [ContentPart]
    let createdAt: String?
}

// MARK: - Conversations

nonisolated struct ConversationSummary: Decodable, Identifiable, Hashable {
    let id: String
    let title: String?
    let lastActiveAt: String?
}

nonisolated struct ConversationMeta: Decodable {
    let id: String
    let title: String?
    let activeRun: Bool
}

// MARK: - Interactions

nonisolated enum InteractionKind: String, Decodable {
    case approval
    case question
}

nonisolated struct ApprovalPrompt: Decodable, Hashable {
    let summary: String?
    let tool: String?
    let args: JSONValue?
    let trustTier: String?
    let scope: String?

    enum CodingKeys: String, CodingKey {
        case summary
        case tool
        case args
        case trustTier = "trust_tier"
        case scope
    }
}

nonisolated struct QuestionOption: Decodable, Hashable {
    let label: String
    let description: String?
}

nonisolated struct QuestionPrompt: Decodable, Hashable {
    let question: String
    let options: [QuestionOption]?
    let multiSelect: Bool?
    let allowFreeform: Bool?

    enum CodingKeys: String, CodingKey {
        case question
        case options
        case multiSelect = "multi_select"
        case allowFreeform = "allow_freeform"
    }
}

/// The decoded prompt of an interaction, branched on `kind`. A missing/renamed field is a
/// real decode error (the whole `Interaction` fails to decode) rather than a silent nil that
/// would park the run with no card and no diagnostic.
nonisolated enum InteractionPrompt {
    case approval(ApprovalPrompt)
    case question(QuestionPrompt)
}

/// The interaction row. The `prompt` jsonb is decoded into the concrete `ApprovalPrompt` /
/// `QuestionPrompt` based on `kind` right here, so the call site gets a typed prompt and any
/// shape mismatch surfaces as a thrown decode error. Decode this from the
/// `{ interaction: { ... } }` wrapper at the call site.
nonisolated struct Interaction: Decodable {
    let id: String
    let kind: InteractionKind
    let prompt: InteractionPrompt
    let status: String

    private enum CodingKeys: String, CodingKey {
        case id, kind, prompt, status
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.kind = try c.decode(InteractionKind.self, forKey: .kind)
        self.status = try c.decode(String.self, forKey: .status)
        switch kind {
        case .approval:
            self.prompt = .approval(try c.decode(ApprovalPrompt.self, forKey: .prompt))
        case .question:
            self.prompt = .question(try c.decode(QuestionPrompt.self, forKey: .prompt))
        }
    }
}

// MARK: - Run events (SSE)

nonisolated enum RunEvent: Decodable {
    case token(String)
    case toolCallStart(id: String, toolName: String, args: JSONValue?)
    case toolCallEnd(id: String)
    case done
    case cancelled
    case error(message: String)
    case interactionRequired(interactionId: String, kind: InteractionKind)
    case interactionResolved(interactionId: String)
    case title(String)
    case unknown

    private enum CodingKeys: String, CodingKey {
        case type
        case text
        case id
        case toolName
        case args
        case message
        case interactionId
        case kind
        case title
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = (try? c.decode(String.self, forKey: .type)) ?? ""
        switch type {
        case "token":
            self = .token((try? c.decode(String.self, forKey: .text)) ?? "")
        case "tool_call_start":
            self = .toolCallStart(
                id: (try? c.decode(String.self, forKey: .id)) ?? "",
                toolName: (try? c.decode(String.self, forKey: .toolName)) ?? "tool",
                args: try? c.decode(JSONValue.self, forKey: .args)
            )
        case "tool_call_end":
            self = .toolCallEnd(id: (try? c.decode(String.self, forKey: .id)) ?? "")
        case "done":
            self = .done
        case "cancelled":
            self = .cancelled
        case "error":
            self = .error(message: (try? c.decode(String.self, forKey: .message)) ?? "Unknown error")
        case "interaction_required":
            let interactionId = (try? c.decode(String.self, forKey: .interactionId)) ?? ""
            let kind = (try? c.decode(InteractionKind.self, forKey: .kind)) ?? .approval
            self = .interactionRequired(interactionId: interactionId, kind: kind)
        case "interaction_resolved":
            self = .interactionResolved(
                interactionId: (try? c.decode(String.self, forKey: .interactionId)) ?? ""
            )
        case "title":
            self = .title((try? c.decode(String.self, forKey: .title)) ?? "")
        default:
            self = .unknown
        }
    }
}

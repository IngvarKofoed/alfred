//
//  ConversationTransport.swift
//  Alfred
//
//  The one transport seam the conversation logic depends on. Today the only conformer is
//  AlfredClient (REST + SSE); a future VoiceSession would conform the same surface and emit
//  the same RunEvents into the same view model, so nothing in ConversationViewModel assumes
//  its events came from SSE (clients/ios/CLAUDE.md). Cancel returns whether something was
//  actually cancelled (false ⇒ 409 nothing-active) so the caller can self-heal.
//

import Foundation

protocol ConversationTransport: AnyObject {
    /// A reconnecting stream of run events for a conversation.
    func events(conversationId: String) -> AsyncStream<RunEvent>

    /// The durable transcript.
    func messages(_ conversationId: String) async throws -> [WireMessage]

    /// Conversation meta (title + refresh-proof `activeRun`).
    func conversation(_ id: String) async throws -> ConversationMeta

    /// Post a user message. Throws `AlfredError.busy` on 409.
    func send(conversationId: String, text: String?, attachments: [Attachment]) async throws

    /// Cancel the conversation's active run. Returns `true` when a run was cancelled, `false`
    /// when nothing was active (HTTP 409) — so the caller can clear a stuck-busy state.
    @discardableResult
    func cancel(conversationId: String) async throws -> Bool

    /// Fetch an interaction row (typed prompt decoded by `kind`).
    func interaction(_ id: String) async throws -> Interaction

    func resolveApproval(_ id: String, approved: Bool, note: String?, remember: Bool) async throws
    func resolveQuestion(_ id: String, selectedLabels: [String], freeformText: String?) async throws

    /// Upload an image into the conversation workspace.
    func upload(conversationId: String, jpegData: Data) async throws -> Attachment

    /// Resolve a workspace-relative path to an absolute /media URL.
    func mediaURL(conversationId: String, path: String) -> URL?
}

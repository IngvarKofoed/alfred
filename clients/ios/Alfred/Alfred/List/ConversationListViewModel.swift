//
//  ConversationListViewModel.swift
//  Alfred
//
//  Backs the conversation history/list screen: loads the owner's recent conversations
//  from `GET /api/conversations` and surfaces a load error for the empty/error state.
//

import Foundation

@MainActor
@Observable
final class ConversationListViewModel {
    private let client: AlfredClient

    var conversations: [ConversationSummary] = []
    var loadError: String?

    init(client: AlfredClient) {
        self.client = client
    }

    /// Fetch the conversation list. On success clears any prior error; on failure leaves the
    /// last-known list in place and sets a human-readable `loadError` for the view to show.
    func load() async {
        do {
            conversations = try await client.conversations()
            loadError = nil
        } catch AlfredError.notConfigured {
            loadError = "Set the server address in Settings to load conversations."
        } catch {
            loadError = "Couldn’t load conversations. Check the connection and try again."
        }
    }
}

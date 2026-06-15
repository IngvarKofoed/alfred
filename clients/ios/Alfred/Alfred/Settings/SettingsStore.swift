//
//  SettingsStore.swift
//  Alfred
//
//  Persists the list of saved Alfred servers (each a labelled base URL) in UserDefaults,
//  plus which one is active. The active server's URL is written through to the legacy
//  `alfred.baseURL` key so `AlfredClient`'s nonisolated per-call resolve path stays unchanged.
//  Network position is the auth (ARCHITECTURE §12) — there is no login.
//

import Foundation

/// A saved Alfred server: a labelled base URL the owner can switch between.
/// `label` may be empty (the UI falls back to the URL host).
struct Server: Codable, Identifiable, Hashable {
    let id: UUID
    var label: String
    var urlString: String
}

@MainActor
@Observable
final class SettingsStore {
    private nonisolated static let baseURLKey = "alfred.baseURL"
    private nonisolated static let serversKey = "alfred.servers"
    private nonisolated static let activeServerIDKey = "alfred.activeServerID"

    /// The saved servers, persisted as JSON to `alfred.servers`.
    var servers: [Server] {
        didSet {
            persistServers()
            syncActiveBaseURL()
        }
    }

    /// The active server's id, persisted to `alfred.activeServerID`; nil = none active.
    var activeServerID: UUID? {
        didSet {
            persistActiveServerID()
            syncActiveBaseURL()
        }
    }

    /// The currently active server, or nil if none is selected (or it was deleted).
    var activeServer: Server? { servers.first { $0.id == activeServerID } }

    /// A thread-safe resolver of the current base URL, readable off the main actor: it reads the
    /// persisted string straight from `UserDefaults` (itself thread-safe) rather than the
    /// `@MainActor` stored state, so `AlfredClient`'s non-isolated request/stream tasks can resolve
    /// the URL per call without a cross-actor read of MainActor-isolated state. Unchanged: it reads
    /// the legacy `alfred.baseURL` key that the active server is written through to.
    nonisolated var resolvedBaseURL: URL? {
        Self.validatedURL(from: UserDefaults.standard.string(forKey: Self.baseURLKey) ?? "")
    }

    /// Validates an http(s) URL with a host — the single validation rule. Internal (not private)
    /// so the view can show per-row valid/invalid the way the old footer did.
    nonisolated static func validatedURL(from string: String) -> URL? {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host != nil
        else { return nil }
        return url
    }

    // MARK: - Mutations

    /// Append a new server. If nothing is active yet, the new server becomes active.
    func addServer(label: String, urlString: String) {
        let server = Server(id: UUID(), label: label, urlString: urlString)
        servers.append(server)
        if activeServerID == nil {
            activeServerID = server.id
        }
    }

    /// Edit a server's label + URL in place (no-op if the id isn't found). Mutates a copy and
    /// reassigns once, so the `servers` didSet fires a single time (persist + write-through when
    /// it's the active one) while preserving any other fields a Server might gain later.
    func updateServer(id: UUID, label: String, urlString: String) {
        guard let index = servers.firstIndex(where: { $0.id == id }) else { return }
        var updated = servers[index]
        updated.label = label
        updated.urlString = urlString
        servers[index] = updated
    }

    /// Remove a server; if it was the active one, clear the active selection.
    func deleteServer(id: UUID) {
        servers.removeAll { $0.id == id }
        if activeServerID == id {
            activeServerID = nil
        }
    }

    /// Make `id` the active server.
    func activate(id: UUID) {
        activeServerID = id
    }

    // MARK: - Persistence

    /// Writes the active server's raw URL string (or "" when no server is active) to the legacy
    /// `alfred.baseURL` key, so the unchanged nonisolated `resolvedBaseURL` reader (and
    /// `AlfredClient`) see it. `resolvedBaseURL` re-validates, so an invalid or empty string
    /// resolves to nil → `AlfredError.notConfigured`, exactly as a blank field behaved.
    private func syncActiveBaseURL() {
        UserDefaults.standard.set(activeServer?.urlString ?? "", forKey: Self.baseURLKey)
    }

    private func persistServers() {
        guard let data = try? AlfredJSON.encoder.encode(servers) else { return }
        UserDefaults.standard.set(data, forKey: Self.serversKey)
    }

    private func persistActiveServerID() {
        if let id = activeServerID {
            UserDefaults.standard.set(id.uuidString, forKey: Self.activeServerIDKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.activeServerIDKey)
        }
    }

    init() {
        // Decode the saved list ([] if absent/garbage) and active id (nil if absent/invalid).
        if let data = UserDefaults.standard.data(forKey: Self.serversKey),
           let decoded = try? AlfredJSON.decoder.decode([Server].self, from: data) {
            self.servers = decoded
        } else {
            self.servers = []
        }
        if let raw = UserDefaults.standard.string(forKey: Self.activeServerIDKey) {
            self.activeServerID = UUID(uuidString: raw)
        } else {
            self.activeServerID = nil
        }
        // Intentionally do NOT call syncActiveBaseURL() here: Swift `didSet` does not fire during
        // initialization, so the legacy `alfred.baseURL` value (e.g. an install that hasn't migrated
        // — migration is out of scope, handled manually) survives untouched until the owner first
        // adds/activates a server.
    }
}

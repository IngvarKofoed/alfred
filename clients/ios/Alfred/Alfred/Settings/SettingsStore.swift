//
//  SettingsStore.swift
//  Alfred
//
//  Persists the server base URL (the Tailscale MagicDNS HTTPS host) in UserDefaults.
//  Network position is the auth (ARCHITECTURE §12) — there is no login.
//

import Foundation

@MainActor
@Observable
final class SettingsStore {
    private nonisolated static let defaultsKey = "alfred.baseURL"

    var baseURLString: String {
        didSet { UserDefaults.standard.set(baseURLString, forKey: Self.defaultsKey) }
    }

    /// The validated base URL, or nil if the stored string is empty / not a valid http(s) URL.
    /// The single validated source — views and the client consume this, not their own trim.
    var baseURL: URL? { Self.validatedURL(from: baseURLString) }

    /// Whether the stored string is blank (so the view can tell "not configured yet" apart from
    /// "configured but invalid"), trimmed the same way validation trims.
    var isURLBlank: Bool {
        baseURLString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// A thread-safe resolver of the current base URL, readable off the main actor: it reads the
    /// persisted string straight from `UserDefaults` (itself thread-safe) rather than the
    /// `@MainActor` stored `baseURLString`, so `AlfredClient`'s non-isolated request/stream tasks
    /// can resolve the URL per call without a cross-actor read of MainActor-isolated state.
    nonisolated var resolvedBaseURL: URL? {
        Self.validatedURL(from: UserDefaults.standard.string(forKey: Self.defaultsKey) ?? "")
    }

    private nonisolated static func validatedURL(from string: String) -> URL? {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host != nil
        else { return nil }
        return url
    }

    init() {
        self.baseURLString = UserDefaults.standard.string(forKey: Self.defaultsKey) ?? ""
    }
}

//
//  AlfredError.swift
//  Alfred
//

import Foundation

nonisolated enum AlfredError: Error {
    /// No base URL is configured in Settings.
    case notConfigured
    /// HTTP 409 — the conversation already has an active run.
    case busy
    /// HTTP 422 — the uploaded audio transcribed to nothing (silence/noise); the caller can
    /// resume listening rather than surfacing this as an error.
    case emptyTranscript
    /// A non-success HTTP status (carrying the status code).
    case http(Int)
    /// The response body could not be decoded into the expected shape.
    case decoding
    /// A transport-level failure (no network, TLS, timeout, …).
    case transport(Error)
}

extension AlfredError: LocalizedError {
    /// The single owner-facing message for each case — the one presenter, so call sites never
    /// re-switch on the error. The transport case preserves the underlying detail where useful.
    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "No server configured — set the base URL in Settings."
        case .busy:
            return "Alfred is already working on this conversation."
        case .emptyTranscript:
            return "Didn't catch that — try speaking again."
        case .http(let code):
            return "Request failed (HTTP \(code))."
        case .decoding:
            return "Couldn't read the server's response."
        case .transport(let underlying):
            return "Couldn't reach the server — \(underlying.localizedDescription)"
        }
    }
}

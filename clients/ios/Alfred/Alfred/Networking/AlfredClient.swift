//
//  AlfredClient.swift
//  Alfred
//
//  The transport: async methods over URLSession against the alfred-webserver REST + SSE
//  API. The base URL is resolved lazily on every call (from Settings) so changing it in
//  Settings takes effect without rebuilding the client.
//

import Foundation

final class AlfredClient {
    private let baseURLProvider: () -> URL?
    private let session: URLSession

    init(baseURLProvider: @escaping () -> URL?, session: URLSession = .shared) {
        self.baseURLProvider = baseURLProvider
        self.session = session
    }

    // MARK: - URL helpers

    private func baseURL() throws -> URL {
        guard let url = baseURLProvider() else { throw AlfredError.notConfigured }
        return url
    }

    /// Build an absolute URL for an API path, **preserving any path prefix on the base URL**
    /// (e.g. a reverse-proxy mount) — `URL(string: "/api/…", relativeTo: base)` drops it. The
    /// `path` segments are already percent-encoded (via `encodePathSegment`), so we splice them
    /// onto the base's own (also percent-encoded) path rather than re-encoding. One helper, used
    /// by every route (resolving the active base) and by `health(for:)` (explicit base).
    private func url(_ path: String) throws -> URL {
        try url(path, base: try baseURL())
    }

    /// The prefix-preserving splice against an **explicit** base — used by `url(_:)` (active base)
    /// and by `health(for:)`, which probes a server before it's the active one (so it can't go
    /// through `baseURLProvider`).
    private func url(_ path: String, base: URL) throws -> URL {
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            throw AlfredError.notConfigured
        }
        let basePath = components.percentEncodedPath
        let prefix = basePath.hasSuffix("/") ? String(basePath.dropLast()) : basePath
        let suffix = path.hasPrefix("/") ? path : "/" + path
        components.percentEncodedPath = prefix + suffix
        guard let url = components.url else { throw AlfredError.notConfigured }
        return url
    }

    private func encodePathSegment(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }

    // MARK: - Core request runners

    /// Perform a request and decode a JSON body into `T`.
    private func decode<T: Decodable>(_ type: T.Type, _ request: URLRequest) async throws -> T {
        let data = try await perform(request)
        do {
            return try AlfredJSON.decoder.decode(T.self, from: data)
        } catch {
            throw AlfredError.decoding
        }
    }

    /// Perform a request, validate the status, return the raw body. Maps 409 → `.busy`.
    @discardableResult
    private func perform(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw AlfredError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw AlfredError.decoding
        }
        if http.statusCode == 409 { throw AlfredError.busy }
        guard (200...299).contains(http.statusCode) else {
            throw AlfredError.http(http.statusCode)
        }
        return data
    }

    private func jsonRequest(_ url: URL, method: String, body: [String: Any?]? = nil) throws -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let body {
            // Strip nils so optional fields are omitted, not sent as JSON null.
            let compacted = body.compactMapValues { $0 }
            request.httpBody = try? JSONSerialization.data(withJSONObject: compacted)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    // MARK: - Health

    struct HealthResponse: Decodable { let ok: Bool; let version: String? }

    /// Probe a **given** base URL's `GET /api/health`, bypassing `baseURLProvider` — used by the
    /// Settings page to test a server before it's the active one. Builds the URL with the same
    /// prefix-preserving splice as every other route. A transport error / non-2xx surfaces as the
    /// usual `AlfredError` so the caller renders "unreachable".
    func health(for baseURL: URL) async throws -> HealthResponse {
        var request = URLRequest(url: try url("/api/health", base: baseURL))
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let data = try await perform(request)
        do {
            return try AlfredJSON.decoder.decode(HealthResponse.self, from: data)
        } catch {
            throw AlfredError.decoding
        }
    }

    // MARK: - Conversations

    private struct ConversationsResponse: Decodable { let conversations: [ConversationSummary] }

    func conversations() async throws -> [ConversationSummary] {
        let request = try jsonRequest(url("/api/conversations"), method: "GET")
        return try await decode(ConversationsResponse.self, request).conversations
    }

    func conversation(_ id: String) async throws -> ConversationMeta {
        let request = try jsonRequest(
            url("/api/conversations/\(encodePathSegment(id))"), method: "GET"
        )
        return try await decode(ConversationMeta.self, request)
    }

    // MARK: - Messages

    private struct MessagesResponse: Decodable { let messages: [WireMessage] }

    func messages(_ conversationId: String) async throws -> [WireMessage] {
        let request = try jsonRequest(
            url("/api/conversations/\(encodePathSegment(conversationId))/messages"), method: "GET"
        )
        return try await decode(MessagesResponse.self, request).messages
    }

    /// Post a user message. Throws `AlfredError.busy` on 409.
    func send(conversationId: String, text: String?, attachments: [Attachment]) async throws {
        var body: [String: Any?] = [:]
        if let text, !text.isEmpty { body["text"] = text }
        if !attachments.isEmpty {
            body["attachments"] = attachments.map { ["path": $0.path, "mimeType": $0.mimeType] }
        }
        let request = try jsonRequest(
            url("/api/conversations/\(encodePathSegment(conversationId))/messages"),
            method: "POST",
            body: body
        )
        try await perform(request)
    }

    /// Cancel the conversation's active run. Returns `true` when a run was cancelled, `false`
    /// when nothing was active (HTTP 409) so the caller can self-heal a stuck-busy state.
    @discardableResult
    func cancel(conversationId: String) async throws -> Bool {
        let request = try jsonRequest(
            url("/api/conversations/\(encodePathSegment(conversationId))/cancel"), method: "POST"
        )
        do {
            try await perform(request)
            return true
        } catch AlfredError.busy {
            // 409 ⇒ nothing was active; report it so the caller clears busy + reloads.
            return false
        }
    }

    // MARK: - File upload

    func upload(conversationId: String, jpegData: Data) async throws -> Attachment {
        let target = try url("/api/conversations/\(encodePathSegment(conversationId))/files")
        let boundary = "Boundary-\(UUID().uuidString)"
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        let crlf = "\r\n"
        body.append("--\(boundary)\(crlf)")
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"photo.jpg\"\(crlf)")
        body.append("Content-Type: image/jpeg\(crlf)\(crlf)")
        body.append(jpegData)
        body.append(crlf)
        body.append("--\(boundary)--\(crlf)")
        request.httpBody = body

        let data = try await perform(request)
        do {
            return try AlfredJSON.decoder.decode(Attachment.self, from: data)
        } catch {
            throw AlfredError.decoding
        }
    }

    // MARK: - Audio upload (voice)

    /// Upload a WAV utterance to the STT+run-creation route. Returns `{ runId, transcript }` on
    /// success. Maps HTTP 422 → `.emptyTranscript` (silence/noise) so the caller can resume
    /// listening without surfacing an error, and keeps `perform()`'s 409 → `.busy` mapping.
    func uploadAudio(conversationId: String, wavData: Data) async throws -> AudioUploadResponse {
        let target = try url("/api/conversations/\(encodePathSegment(conversationId))/audio")
        let boundary = "Boundary-\(UUID().uuidString)"
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        var body = Data()
        let crlf = "\r\n"
        body.append("--\(boundary)\(crlf)")
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\(crlf)")
        body.append("Content-Type: audio/wav\(crlf)\(crlf)")
        body.append(wavData)
        body.append(crlf)
        body.append("--\(boundary)--\(crlf)")
        request.httpBody = body

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw AlfredError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw AlfredError.decoding
        }
        if http.statusCode == 409 { throw AlfredError.busy }
        if http.statusCode == 422 { throw AlfredError.emptyTranscript }
        guard (200...299).contains(http.statusCode) else {
            throw AlfredError.http(http.statusCode)
        }
        do {
            return try AlfredJSON.decoder.decode(AudioUploadResponse.self, from: data)
        } catch {
            throw AlfredError.decoding
        }
    }

    // MARK: - Interactions

    private struct InteractionResponse: Decodable { let interaction: Interaction }

    func interaction(_ id: String) async throws -> Interaction {
        let request = try jsonRequest(
            url("/api/interactions/\(encodePathSegment(id))"), method: "GET"
        )
        return try await decode(InteractionResponse.self, request).interaction
    }

    func resolveApproval(_ id: String, approved: Bool, note: String?, remember: Bool) async throws {
        let request = try jsonRequest(
            url("/api/interactions/\(encodePathSegment(id))"),
            method: "POST",
            body: ["approved": approved, "note": note, "remember": remember]
        )
        do {
            try await perform(request)
        } catch AlfredError.busy {
            // 409 ⇒ already resolved by another ingress (first-writer-wins); not an error.
        }
    }

    func resolveQuestion(_ id: String, selectedLabels: [String], freeformText: String?) async throws {
        let request = try jsonRequest(
            url("/api/interactions/\(encodePathSegment(id))"),
            method: "POST",
            body: ["selected_labels": selectedLabels, "freeform_text": freeformText]
        )
        do {
            try await perform(request)
        } catch AlfredError.busy {
            // 409 ⇒ already resolved by another ingress; not an error.
        }
    }

    // MARK: - Event stream

    /// A reconnecting stream of run events for a conversation. Transient failures (transport
    /// drops, 5xx, 429) back off (1/2/4/8s, capped) and reconnect — the run model is durable
    /// server-side, so a reconnect rejoins the live stream. A **permanent** HTTP status
    /// (400/401/403/404/410) means reconnecting can never succeed (wrong base URL, gone
    /// conversation), so we surface it once as a `.error` event and finish the stream rather
    /// than spinning silently (fail-loudly, ARCHITECTURE principle).
    func events(conversationId: String) -> AsyncStream<RunEvent> {
        AsyncStream { continuation in
            let task = Task { [weak self] in
                guard let self else { continuation.finish(); return }
                var backoff: UInt64 = 1
                while !Task.isCancelled {
                    guard let streamURL = try? self.url(
                        "/api/conversations/\(self.encodePathSegment(conversationId))/stream"
                    ) else {
                        // Not configured — wait and retry; Settings may be filled in later.
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                        continue
                    }
                    let sse = SSEClient(url: streamURL)
                    do {
                        for try await event in sse.events() {
                            if Task.isCancelled { break }
                            continuation.yield(event)
                        }
                        // Clean close — reset backoff and reconnect promptly.
                        backoff = 1
                    } catch let AlfredError.http(code) where Self.isPermanentStatus(code) {
                        // Permanent: reconnecting can't help. Surface it and stop.
                        continuation.yield(.error(message: "Stream unavailable (HTTP \(code))."))
                        break
                    } catch {
                        // Transient (transport drop, 5xx, 429) — swallow and back off.
                    }
                    if Task.isCancelled { break }
                    try? await Task.sleep(nanoseconds: backoff * 1_000_000_000)
                    backoff = min(backoff * 2, 8)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    /// Permanent (non-retryable) HTTP statuses for the event stream — 429 and 5xx stay transient.
    private static func isPermanentStatus(_ code: Int) -> Bool {
        [400, 401, 403, 404, 410].contains(code)
    }

    // MARK: - Media

    func mediaURL(conversationId: String, path: String) -> URL? {
        // `path` is workspace-relative. The media route is single-segment today, but encode each
        // "/"-separated segment and preserve the full relative path rather than silently
        // collapsing to its last component (which would drop a prefix if one ever appears).
        let encodedConv = encodePathSegment(conversationId)
        let encodedPath = path
            .split(separator: "/", omittingEmptySubsequences: true)
            .map { encodePathSegment(String($0)) }
            .joined(separator: "/")
        return try? url("/media/\(encodedConv)/\(encodedPath)")
    }
}

// The view model depends on this protocol, not the concrete client (the transport seam — a
// future VoiceSession conforms the same surface). AlfredClient's signatures already match.
extension AlfredClient: ConversationTransport {}

private extension Data {
    mutating func append(_ string: String) {
        if let data = string.data(using: .utf8) { append(data) }
    }
}

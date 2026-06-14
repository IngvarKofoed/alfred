//
//  SSEClient.swift
//  Alfred
//
//  A Server-Sent Events reader built on a URLSessionDataDelegate — NOT URLSession.bytes.
//  On iOS, URLSession.bytes(for:) connects (HTTP 200) but then buffers the response body
//  indefinitely for a low-volume long-lived stream: frames the server flushes (confirmed via
//  `curl -N` and macOS URLSession.bytes) never reach `.lines`, so the chat spinner hangs with
//  no reply. The delegate's `didReceive(data:)` callback delivers each chunk the moment it
//  arrives, which streams reliably on iOS. We accumulate bytes, split SSE frames on the
//  blank-line separator, skip `event: ping` keep-alives, and decode each `data:` payload.
//

import Foundation

nonisolated struct SSEClient {
    private let url: URL

    init(url: URL) {
        self.url = url
    }

    /// A stream of decoded `RunEvent`s. Finishes when the connection closes; throws on a
    /// non-2xx status or a transport error (the caller — `AlfredClient.events` — reconnects).
    func events() -> AsyncThrowingStream<RunEvent, Error> {
        AsyncThrowingStream { continuation in
            let delegate = SSEDelegate(continuation: continuation)
            let config = URLSessionConfiguration.ephemeral
            // The server pings ~every 30s, so data arrives at least that often; a request
            // timeout comfortably above that detects a dead connection without tripping on idle.
            // (Not .greatestFiniteMagnitude — extreme values misbehave.)
            config.timeoutIntervalForRequest = 120
            config.waitsForConnectivity = true
            config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            // A dedicated session per stream; the delegate is retained by the session, and the
            // session is kept alive by the onTermination closure below for the stream's lifetime.
            let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)

            var request = URLRequest(url: url)
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
            // Avoid any transparent compression that would buffer a low-volume stream.
            request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")

            let task = session.dataTask(with: request)
            continuation.onTermination = { _ in
                task.cancel()
                session.invalidateAndCancel()
            }
            task.resume()
        }
    }
}

/// URLSession delegate that turns incremental `didReceive(data:)` callbacks into decoded
/// RunEvents. URLSession invokes these on a private serial queue (delegateQueue: nil), so the
/// `buffer` is only ever touched serially — safe without extra locking.
private final class SSEDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let continuation: AsyncThrowingStream<RunEvent, Error>.Continuation
    private var buffer = Data()
    private static let frameSeparator = Data([0x0a, 0x0a]) // "\n\n"

    init(continuation: AsyncThrowingStream<RunEvent, Error>.Continuation) {
        self.continuation = continuation
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            continuation.finish(throwing: AlfredError.http(http.statusCode))
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        buffer.append(data)
        // Emit every complete frame (terminated by a blank line) currently in the buffer.
        while let sep = buffer.range(of: Self.frameSeparator) {
            let frame = Data(buffer[buffer.startIndex..<sep.lowerBound])
            buffer = Data(buffer[sep.upperBound...])
            if let event = Self.parse(frame) {
                continuation.yield(event)
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let urlError = error as? URLError, urlError.code == .cancelled {
            continuation.finish()
        } else if let error {
            continuation.finish(throwing: error)
        } else {
            continuation.finish()
        }
    }

    /// Parse one SSE frame: gather `data:` lines (per spec, trimming one leading space), skip
    /// a `ping` event and `:` comments, then JSON-decode the joined payload into a RunEvent.
    private static func parse(_ frame: Data) -> RunEvent? {
        guard let text = String(data: frame, encoding: .utf8) else { return nil }
        var dataLines: [String] = []
        var isPing = false
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix(":") { continue }
            if line.hasPrefix("event:") {
                if line.dropFirst("event:".count).trimmingCharacters(in: .whitespaces) == "ping" {
                    isPing = true
                }
            } else if line.hasPrefix("data:") {
                var value = String(line.dropFirst("data:".count))
                if value.hasPrefix(" ") { value.removeFirst() }
                dataLines.append(value)
            }
        }
        guard !isPing, !dataLines.isEmpty else { return nil }
        let payload = dataLines.joined(separator: "\n")
        guard !payload.isEmpty, let json = payload.data(using: .utf8) else { return nil }
        return try? AlfredJSON.decoder.decode(RunEvent.self, from: json)
    }
}

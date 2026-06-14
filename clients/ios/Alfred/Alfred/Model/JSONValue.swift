//
//  JSONValue.swift
//  Alfred
//
//  A loosely-typed JSON value used for fields whose shape is dynamic on the wire
//  (tool args, interaction prompts/responses). Decodes any valid JSON tree and can
//  re-encode + decode into a concrete Codable type via `decoded(_:)`.
//

import Foundation

/// Shared, reusable JSON coders. Centralized here so every decode site (AlfredClient, SSEClient,
/// JSONValue.decoded) shares one configuration — a future `keyDecodingStrategy` change lands in
/// one place and can't half-apply — and so we don't allocate a fresh coder per frame/call.
enum AlfredJSON {
    nonisolated(unsafe) static let decoder = JSONDecoder()
    nonisolated(unsafe) static let encoder = JSONEncoder()
}

nonisolated enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
            return
        }
        // Bool must be probed before Double: JSONDecoder will happily decode
        // `true`/`false` as 1.0/0.0 otherwise.
        if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? container.decode(Double.self) {
            self = .number(n)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let arr = try? container.decode([JSONValue].self) {
            self = .array(arr)
        } else if let obj = try? container.decode([String: JSONValue].self) {
            self = .object(obj)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let s): try container.encode(s)
        case .number(let n): try container.encode(n)
        case .bool(let b): try container.encode(b)
        case .object(let o): try container.encode(o)
        case .array(let a): try container.encode(a)
        case .null: try container.encodeNil()
        }
    }
}

extension JSONValue {
    /// A compact "k: v, ..." rendering for tool chips and inline summaries (~80 chars).
    var summary: String {
        let full = render
        if full.count <= 80 { return full }
        return String(full.prefix(79)) + "\u{2026}"
    }

    /// The full, un-truncated rendering used by `summary`.
    private var render: String {
        switch self {
        case .string(let s): return s
        case .number(let n):
            // Drop a trailing ".0" so integers read cleanly.
            if n == n.rounded() && abs(n) < 1e15 {
                return String(Int64(n))
            }
            return String(n)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        case .array(let a):
            return "[" + a.map { $0.render }.joined(separator: ", ") + "]"
        case .object(let o):
            return o
                .sorted { $0.key < $1.key }
                .map { "\($0.key): \($0.value.render)" }
                .joined(separator: ", ")
        }
    }
}

extension JSONValue {
    /// Re-encode this value and decode it into a concrete `Decodable` type.
    /// Returns nil rather than throwing so callers can fall back gracefully; logs on failure
    /// so a silent nil (which would park a run with no diagnostic) leaves a trace.
    func decoded<T: Decodable>(_ type: T.Type) -> T? {
        do {
            let data = try AlfredJSON.encoder.encode(self)
            return try AlfredJSON.decoder.decode(T.self, from: data)
        } catch {
            print("JSONValue.decoded(\(T.self)) failed: \(error)")
            return nil
        }
    }
}

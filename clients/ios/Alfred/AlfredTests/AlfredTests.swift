//
//  AlfredTests.swift
//  AlfredTests
//
//  Pure-logic unit tests for the wire model: RunEvent SSE decoding (incl. an
//  unrecognized type → .unknown) and JSONValue encode/decode round-trips.
//

import Testing
import Foundation
@testable import Alfred

struct AlfredTests {

    // MARK: - RunEvent decoding

    private func decodeEvent(_ json: String) throws -> RunEvent {
        let data = Data(json.utf8)
        return try JSONDecoder().decode(RunEvent.self, from: data)
    }

    @Test func decodesTokenEvent() throws {
        let event = try decodeEvent(#"{"type":"token","text":"hello"}"#)
        guard case .token(let text) = event else {
            Issue.record("expected .token, got \(event)")
            return
        }
        #expect(text == "hello")
    }

    @Test func decodesToolCallStartWithArgs() throws {
        let event = try decodeEvent(
            #"{"type":"tool_call_start","id":"t1","toolName":"navigate","args":{"url":"https://example.com"}}"#
        )
        guard case .toolCallStart(let id, let toolName, let args) = event else {
            Issue.record("expected .toolCallStart, got \(event)")
            return
        }
        #expect(id == "t1")
        #expect(toolName == "navigate")
        #expect(args != nil)
    }

    @Test func decodesInteractionRequiredQuestion() throws {
        let event = try decodeEvent(
            #"{"type":"interaction_required","interactionId":"i9","kind":"question"}"#
        )
        guard case .interactionRequired(let interactionId, let kind) = event else {
            Issue.record("expected .interactionRequired, got \(event)")
            return
        }
        #expect(interactionId == "i9")
        #expect(kind == .question)
    }

    @Test func decodesDoneAndCancelledAndTitle() throws {
        #expect({ if case .done = try? decodeEvent(#"{"type":"done"}"#) { return true } else { return false } }())
        #expect({ if case .cancelled = try? decodeEvent(#"{"type":"cancelled"}"#) { return true } else { return false } }())

        let titleEvent = try decodeEvent(#"{"type":"title","title":"My chat"}"#)
        guard case .title(let title) = titleEvent else {
            Issue.record("expected .title, got \(titleEvent)")
            return
        }
        #expect(title == "My chat")
    }

    @Test func unknownTypeDecodesToUnknownNeverThrows() throws {
        // An unrecognized "type" must NOT throw — it must decode to .unknown so a
        // future server event never breaks the stream.
        let event = try decodeEvent(#"{"type":"some_future_event","payload":42}"#)
        guard case .unknown = event else {
            Issue.record("expected .unknown, got \(event)")
            return
        }
    }

    // MARK: - JSONValue round-trip

    @Test func jsonValueRoundTripsNestedTree() throws {
        let original = #"{"a":1,"b":"two","c":true,"d":null,"e":[1,2,3],"f":{"g":false}}"#
        let data = Data(original.utf8)

        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        let reencoded = try JSONEncoder().encode(value)
        let again = try JSONDecoder().decode(JSONValue.self, from: reencoded)

        // Equatable via Hashable conformance: a decode → encode → decode round-trip
        // must be stable.
        #expect(value == again)

        guard case .object(let obj) = value else {
            Issue.record("expected top-level object")
            return
        }
        #expect(obj["b"] == .string("two"))
        #expect(obj["c"] == .bool(true))
        #expect(obj["d"] == .null)
        #expect(obj["e"] == .array([.number(1), .number(2), .number(3)]))
    }

    @Test func jsonValueDecodedIntoConcreteType() throws {
        // `decoded(_:)` re-encodes then decodes into a concrete Decodable.
        let value = JSONValue.object([
            "path": .string("img/photo.jpg"),
            "mimeType": .string("image/jpeg"),
        ])
        let attachment = value.decoded(Attachment.self)
        #expect(attachment?.path == "img/photo.jpg")
        #expect(attachment?.mimeType == "image/jpeg")
    }

    @Test func jsonValueSummaryIsCompact() {
        let value = JSONValue.object(["b": .number(2), "a": .number(1)])
        // Object keys are rendered sorted.
        #expect(value.summary == "a: 1, b: 2")
    }
}

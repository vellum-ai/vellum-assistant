import Foundation

// MARK: - AnyCodable

/// Lightweight wrapper for arbitrary JSON values in tool input dictionaries.
/// Supports String, Int, Double, Bool, null, arrays, and nested objects.
struct AnyCodable: Codable, Equatable, @unchecked Sendable {
    let value: Any?

    init(_ value: Any?) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = nil
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map { $0.value }
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value type")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if value == nil {
            try container.encodeNil()
        } else if let bool = value as? Bool {
            try container.encode(bool)
        } else if let int = value as? Int {
            try container.encode(int)
        } else if let double = value as? Double {
            try container.encode(double)
        } else if let string = value as? String {
            try container.encode(string)
        } else if let array = value as? [Any?] {
            try container.encode(array.map { AnyCodable($0) })
        } else if let dict = value as? [String: Any?] {
            try container.encode(dict.mapValues { AnyCodable($0) })
        } else {
            try container.encodeNil()
        }
    }

    static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        switch (lhs.value, rhs.value) {
        case (nil, nil):
            return true
        case let (l as Bool, r as Bool):
            return l == r
        case let (l as Int, r as Int):
            return l == r
        case let (l as Double, r as Double):
            return l == r
        case let (l as String, r as String):
            return l == r
        case let (l as [Any?], r as [Any?]):
            return l.count == r.count && zip(l, r).allSatisfy { AnyCodable($0) == AnyCodable($1) }
        case let (l as [String: Any?], r as [String: Any?]):
            guard l.count == r.count else { return false }
            return l.allSatisfy { key, lVal in
                guard let rVal = r[key] else { return false }
                return AnyCodable(lVal) == AnyCodable(rVal)
            }
        default:
            return false
        }
    }
}

// MARK: - Client → Server Messages (Encodable)

/// Attachment payload sent inline as base64. Mirrors `UserMessageAttachment` from ipc-protocol.ts.
struct IPCAttachment: Codable, Sendable {
    let filename: String
    let mimeType: String
    let data: String
    let extractedText: String?
}

/// Sent to create a new computer-use session.
/// Wire type: `"cu_session_create"`
struct CuSessionCreateMessage: Encodable, Sendable {
    let type: String = "cu_session_create"
    let sessionId: String
    let task: String
    let screenWidth: Int
    let screenHeight: Int
    let attachments: [IPCAttachment]?
}

/// Sent after each perceive step with AX tree, screenshot, and execution results.
/// Wire type: `"cu_observation"`
struct CuObservationMessage: Encodable, Sendable {
    let type: String = "cu_observation"
    let sessionId: String
    let axTree: String?
    let previousAXTree: String?
    let axDiff: String?
    let secondaryWindows: String?
    let screenshot: String?
    let executionResult: String?
    let executionError: String?
}

/// Sent by the ambient agent with OCR text from periodic screen captures.
/// Wire type: `"ambient_observation"`
struct AmbientObservationMessage: Encodable, Sendable {
    let type: String = "ambient_observation"
    let ocrText: String
    let appName: String?
    let windowTitle: String?
    let timestamp: Double
}

/// Sent to create a new Q&A session.
/// Wire type: `"session_create"`
struct SessionCreateMessage: Encodable, Sendable {
    let type: String = "session_create"
    let title: String?
}

/// Sent to add a user message to an existing Q&A session.
/// Wire type: `"user_message"`
struct UserMessageMessage: Encodable, Sendable {
    let type: String = "user_message"
    let sessionId: String
    let content: String
    let attachments: [IPCAttachment]?
}

/// Keepalive ping.
/// Wire type: `"ping"`
struct PingMessage: Encodable, Sendable {
    let type: String = "ping"
}

// MARK: - Server → Client Messages (Decodable)

/// Action to execute from the inference server.
struct CuActionMessage: Decodable, Sendable {
    let sessionId: String
    let toolName: String
    let input: [String: AnyCodable]
    let reasoning: String?
    let stepNumber: Int
}

/// Session completed successfully.
struct CuCompleteMessage: Decodable, Sendable {
    let sessionId: String
    let summary: String
    let stepCount: Int
}

/// Session-level error from the server.
struct CuErrorMessage: Decodable, Sendable {
    let sessionId: String
    let message: String
}

/// Streamed text delta from the assistant's response.
struct AssistantTextDeltaMessage: Decodable, Sendable {
    let text: String
}

/// Streamed thinking delta from the assistant's reasoning.
struct AssistantThinkingDeltaMessage: Decodable, Sendable {
    let thinking: String
}

/// Signals that the assistant's message is complete.
struct MessageCompleteMessage: Decodable, Sendable {
}

/// Session metadata from the server (e.g. generated title).
struct SessionInfoMessage: Decodable, Sendable {
    let sessionId: String
    let title: String
}

/// Result from ambient observation analysis.
struct AmbientResultMessage: Decodable, Sendable {
    let decision: String
    let summary: String?
    let suggestion: String?
}

/// Discriminated union of all server → client message types relevant to the macOS client.
/// Decodes via the `"type"` field in the JSON payload.
enum ServerMessage: Decodable, Sendable {
    case cuAction(CuActionMessage)
    case cuComplete(CuCompleteMessage)
    case cuError(CuErrorMessage)
    case assistantTextDelta(AssistantTextDeltaMessage)
    case assistantThinkingDelta(AssistantThinkingDeltaMessage)
    case messageComplete(MessageCompleteMessage)
    case sessionInfo(SessionInfoMessage)
    case ambientResult(AmbientResultMessage)
    case pong
    case unknown(String)

    private enum CodingKeys: String, CodingKey {
        case type
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "cu_action":
            let message = try CuActionMessage(from: decoder)
            self = .cuAction(message)
        case "cu_complete":
            let message = try CuCompleteMessage(from: decoder)
            self = .cuComplete(message)
        case "cu_error":
            let message = try CuErrorMessage(from: decoder)
            self = .cuError(message)
        case "assistant_text_delta":
            let message = try AssistantTextDeltaMessage(from: decoder)
            self = .assistantTextDelta(message)
        case "assistant_thinking_delta":
            let message = try AssistantThinkingDeltaMessage(from: decoder)
            self = .assistantThinkingDelta(message)
        case "message_complete":
            let message = try MessageCompleteMessage(from: decoder)
            self = .messageComplete(message)
        case "session_info":
            let message = try SessionInfoMessage(from: decoder)
            self = .sessionInfo(message)
        case "ambient_result":
            let message = try AmbientResultMessage(from: decoder)
            self = .ambientResult(message)
        case "pong":
            self = .pong
        default:
            self = .unknown(type)
        }
    }
}

import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "LLMContextClient")

// MARK: - Normalized LLM Context Models

/// Normalized summary metadata for a single LLM call.
public struct LLMCallSummary: Codable, Sendable, Equatable {
    public let title: String?
    public let subtitle: String?
    public let summary: AnyCodable?
    public let model: String?
    public let provider: String?
    public let status: String?
    public let inputTokens: Int?
    public let outputTokens: Int?
    public let durationMs: Int?

    public init(
        title: String? = nil,
        subtitle: String? = nil,
        summary: AnyCodable? = nil,
        model: String? = nil,
        provider: String? = nil,
        status: String? = nil,
        inputTokens: Int? = nil,
        outputTokens: Int? = nil,
        durationMs: Int? = nil
    ) {
        self.title = title
        self.subtitle = subtitle
        self.summary = summary
        self.model = model
        self.provider = provider
        self.status = status
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.durationMs = durationMs
    }

    /// String form of the normalized summary when the payload uses text.
    public var summaryText: String? {
        summary?.value as? String
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: LLMContextCodingKey.self)
        title = container.decodeString(for: ["title", "label", "name", "heading"])
        subtitle = container.decodeString(for: ["subtitle", "secondaryTitle"])
        summary = container.decodeAnyCodable(for: ["summary", "description", "details", "text", "body", "content", "value"])
        model = container.decodeString(for: ["model"])
        provider = container.decodeString(for: ["provider"])
        status = container.decodeString(for: ["status", "outcome"])
        inputTokens = container.decodeInt(for: ["inputTokens", "input_token_count", "promptTokens"])
        outputTokens = container.decodeInt(for: ["outputTokens", "output_token_count", "completionTokens"])
        durationMs = container.decodeInt(for: ["durationMs", "duration_ms", "elapsedMs"])
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: LLMContextCodingKey.self)
        try container.encodeIfPresent(title, forKey: "title")
        try container.encodeIfPresent(subtitle, forKey: "subtitle")
        try container.encodeIfPresent(summary, forKey: "summary")
        try container.encodeIfPresent(model, forKey: "model")
        try container.encodeIfPresent(provider, forKey: "provider")
        try container.encodeIfPresent(status, forKey: "status")
        try container.encodeIfPresent(inputTokens, forKey: "inputTokens")
        try container.encodeIfPresent(outputTokens, forKey: "outputTokens")
        try container.encodeIfPresent(durationMs, forKey: "durationMs")
    }
}

/// A normalized section inside the request or response payload.
public struct LLMContextSection: Codable, Sendable, Equatable {
    public let kind: LLMContextSectionKind
    public let title: String?
    public let content: AnyCodable?
    public let language: String?
    public let collapsedByDefault: Bool?

    public init(
        kind: LLMContextSectionKind,
        title: String? = nil,
        content: AnyCodable? = nil,
        language: String? = nil,
        collapsedByDefault: Bool? = nil
    ) {
        self.kind = kind
        self.title = title
        self.content = content
        self.language = language
        self.collapsedByDefault = collapsedByDefault
    }

    /// String form of the section content when the payload uses text.
    public var stringContent: String? {
        content?.value as? String
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: LLMContextCodingKey.self)
        let kindRaw = container.decodeString(for: ["kind", "type", "role"]) ?? "unknown"
        kind = LLMContextSectionKind(rawValue: kindRaw)
        title = container.decodeString(for: ["title", "label", "name", "heading"])
        content = container.decodeAnyCodable(for: ["content", "text", "value", "body", "payload", "data"])
        language = container.decodeString(for: ["language", "syntax", "format"])
        collapsedByDefault = container.decodeBool(for: ["collapsedByDefault", "collapsed"])
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: LLMContextCodingKey.self)
        try container.encode(kind, forKey: LLMContextCodingKey.key("kind"))
        try container.encodeIfPresent(title, forKey: "title")
        try container.encodeIfPresent(content, forKey: "content")
        try container.encodeIfPresent(language, forKey: "language")
        try container.encodeIfPresent(collapsedByDefault, forKey: "collapsedByDefault")
    }
}

/// Section kind values returned by the normalized LLM context response.
public enum LLMContextSectionKind: Sendable, Codable, Equatable, CustomStringConvertible {
    case system
    case user
    case assistant
    case tool
    case reasoning
    case input
    case output
    case prompt
    case completion
    case text
    case json
    case code
    case markdown
    case list
    case table
    case metadata
    case other
    case unknown(String)

    public var rawValue: String {
        switch self {
        case .system: return "system"
        case .user: return "user"
        case .assistant: return "assistant"
        case .tool: return "tool"
        case .reasoning: return "reasoning"
        case .input: return "input"
        case .output: return "output"
        case .prompt: return "prompt"
        case .completion: return "completion"
        case .text: return "text"
        case .json: return "json"
        case .code: return "code"
        case .markdown: return "markdown"
        case .list: return "list"
        case .table: return "table"
        case .metadata: return "metadata"
        case .other: return "other"
        case .unknown(let rawValue): return rawValue
        }
    }

    public var description: String {
        rawValue
    }

    public init(rawValue: String) {
        switch rawValue.lowercased() {
        case "system":
            self = .system
        case "user":
            self = .user
        case "assistant":
            self = .assistant
        case "tool":
            self = .tool
        case "reasoning":
            self = .reasoning
        case "input":
            self = .input
        case "output":
            self = .output
        case "prompt":
            self = .prompt
        case "completion":
            self = .completion
        case "text":
            self = .text
        case "json":
            self = .json
        case "code":
            self = .code
        case "markdown":
            self = .markdown
        case "list":
            self = .list
        case "table":
            self = .table
        case "metadata":
            self = .metadata
        case "other":
            self = .other
        default:
            self = .unknown(rawValue)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self = Self(rawValue: try container.decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

private struct LLMContextCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }

    static func key(_ string: String) -> LLMContextCodingKey {
        LLMContextCodingKey(stringValue: string)!
    }
}

private extension KeyedDecodingContainer where Key == LLMContextCodingKey {
    func decodeString(for keys: [String]) -> String? {
        for key in keys {
            guard let codingKey = Key(stringValue: key) else { continue }
            if let value = try? decodeIfPresent(String.self, forKey: codingKey) {
                return value
            }
        }
        return nil
    }

    func decodeInt(for keys: [String]) -> Int? {
        for key in keys {
            guard let codingKey = Key(stringValue: key) else { continue }
            if let value = try? decodeIfPresent(Int.self, forKey: codingKey) {
                return value
            }
        }
        return nil
    }

    func decodeBool(for keys: [String]) -> Bool? {
        for key in keys {
            guard let codingKey = Key(stringValue: key) else { continue }
            if let value = try? decodeIfPresent(Bool.self, forKey: codingKey) {
                return value
            }
        }
        return nil
    }

    func decodeAnyCodable(for keys: [String]) -> AnyCodable? {
        for key in keys {
            guard let codingKey = Key(stringValue: key) else { continue }
            if let value = try? decodeIfPresent(AnyCodable.self, forKey: codingKey) {
                return value
            }
        }
        return nil
    }
}

private extension KeyedEncodingContainer where Key == LLMContextCodingKey {
    mutating func encodeIfPresent(_ value: String?, forKey key: String) throws {
        guard let value, let codingKey = Key(stringValue: key) else { return }
        try encode(value, forKey: codingKey)
    }

    mutating func encodeIfPresent(_ value: Int?, forKey key: String) throws {
        guard let value, let codingKey = Key(stringValue: key) else { return }
        try encode(value, forKey: codingKey)
    }

    mutating func encodeIfPresent(_ value: Bool?, forKey key: String) throws {
        guard let value, let codingKey = Key(stringValue: key) else { return }
        try encode(value, forKey: codingKey)
    }

    mutating func encodeIfPresent(_ value: AnyCodable?, forKey key: String) throws {
        guard let value, let codingKey = Key(stringValue: key) else { return }
        try encode(value, forKey: codingKey)
    }
}

/// A single LLM request/response log entry returned by the context endpoint.
public struct LLMRequestLogEntry: Codable, Identifiable, Sendable {
    public let id: String
    public let requestPayload: AnyCodable
    public let responsePayload: AnyCodable
    public let createdAt: Int
    public let summary: LLMCallSummary?
    public let requestSections: [LLMContextSection]?
    public let responseSections: [LLMContextSection]?
}

/// Response wrapper for the LLM context endpoint.
public struct LLMContextResponse: Codable, Sendable {
    public let messageId: String
    public let logs: [LLMRequestLogEntry]
}

/// Focused client for fetching LLM request/response context for a given message,
/// routed through the gateway.
@MainActor
public protocol LLMContextClientProtocol {
    func fetchContext(messageId: String) async -> LLMContextResponse?
}

/// Gateway-backed implementation of ``LLMContextClientProtocol``.
@MainActor
public struct LLMContextClient: LLMContextClientProtocol {
    nonisolated public init() {}

    public func fetchContext(messageId: String) async -> LLMContextResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/messages/\(messageId)/llm-context",
                timeout: 15
            )
            guard response.isSuccess else {
                log.error("fetchContext failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(LLMContextResponse.self, from: response.data)
        } catch {
            log.error("fetchContext error: \(error.localizedDescription)")
            return nil
        }
    }
}

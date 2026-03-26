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
    public let cacheCreationInputTokens: Int?
    public let cacheReadInputTokens: Int?
    public let stopReason: String?
    public let requestMessageCount: Int?
    public let requestToolCount: Int?
    public let responseMessageCount: Int?
    public let responseToolCallCount: Int?
    public let responsePreview: String?
    public let toolCallNames: [String]?
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
        cacheCreationInputTokens: Int? = nil,
        cacheReadInputTokens: Int? = nil,
        stopReason: String? = nil,
        requestMessageCount: Int? = nil,
        requestToolCount: Int? = nil,
        responseMessageCount: Int? = nil,
        responseToolCallCount: Int? = nil,
        responsePreview: String? = nil,
        toolCallNames: [String]? = nil,
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
        self.cacheCreationInputTokens = cacheCreationInputTokens
        self.cacheReadInputTokens = cacheReadInputTokens
        self.stopReason = stopReason
        self.requestMessageCount = requestMessageCount
        self.requestToolCount = requestToolCount
        self.responseMessageCount = responseMessageCount
        self.responseToolCallCount = responseToolCallCount
        self.responsePreview = responsePreview
        self.toolCallNames = toolCallNames
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
        cacheCreationInputTokens = container.decodeInt(for: ["cacheCreationInputTokens", "cache_creation_input_tokens"])
        cacheReadInputTokens = container.decodeInt(for: ["cacheReadInputTokens", "cache_read_input_tokens"])
        stopReason = container.decodeString(for: ["stopReason", "stop_reason"])
        requestMessageCount = container.decodeInt(for: ["requestMessageCount", "request_message_count"])
        requestToolCount = container.decodeInt(for: ["requestToolCount", "request_tool_count"])
        responseMessageCount = container.decodeInt(for: ["responseMessageCount", "response_message_count"])
        responseToolCallCount = container.decodeInt(for: ["responseToolCallCount", "response_tool_call_count"])
        responsePreview = container.decodeString(for: ["responsePreview", "responseTextPreview", "response_preview"])
        toolCallNames = container.decodeStringArray(for: ["toolCallNames", "tool_call_names"])
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
        try container.encodeIfPresent(cacheCreationInputTokens, forKey: "cacheCreationInputTokens")
        try container.encodeIfPresent(cacheReadInputTokens, forKey: "cacheReadInputTokens")
        try container.encodeIfPresent(stopReason, forKey: "stopReason")
        try container.encodeIfPresent(requestMessageCount, forKey: "requestMessageCount")
        try container.encodeIfPresent(requestToolCount, forKey: "requestToolCount")
        try container.encodeIfPresent(responseMessageCount, forKey: "responseMessageCount")
        try container.encodeIfPresent(responseToolCallCount, forKey: "responseToolCallCount")
        try container.encodeIfPresent(responsePreview, forKey: "responsePreview")
        try container.encodeIfPresent(toolCallNames, forKey: "toolCallNames")
        try container.encodeIfPresent(durationMs, forKey: "durationMs")
    }
}

/// A normalized section inside the request or response payload.
public struct LLMContextSection: Codable, Sendable, Equatable {
    public let kind: LLMContextSectionKind
    public let label: String
    public let role: String?
    public let text: String?
    public let toolName: String?
    public let data: AnyCodable?
    public let language: String?
    public let collapsedByDefault: Bool?

    public init(
        kind: LLMContextSectionKind,
        label: String,
        role: String? = nil,
        text: String? = nil,
        toolName: String? = nil,
        data: AnyCodable? = nil,
        language: String? = nil,
        collapsedByDefault: Bool? = nil
    ) {
        self.kind = kind
        self.label = label
        self.role = role
        self.text = text
        self.toolName = toolName
        self.data = data
        self.language = language
        self.collapsedByDefault = collapsedByDefault
    }

    /// Compatibility initializer for existing Apple-client call sites that still construct sections
    /// with the older title/content shape.
    public init(
        kind: LLMContextSectionKind,
        title: String? = nil,
        content: AnyCodable? = nil,
        language: String? = nil,
        collapsedByDefault: Bool? = nil
    ) {
        self.init(
            kind: kind,
            label: title ?? Self.defaultLabel(for: kind),
            role: nil,
            text: content?.value as? String,
            toolName: nil,
            data: (content?.value as? String) == nil ? content : nil,
            language: language,
            collapsedByDefault: collapsedByDefault
        )
    }

    /// Compatibility alias for older call sites while the Apple clients finish migrating.
    public var title: String? {
        label
    }

    /// Compatibility alias that prefers structured data when available.
    public var content: AnyCodable? {
        data ?? text.map(AnyCodable.init)
    }

    /// String form of the normalized text field, with a fallback for string-backed data.
    public var stringContent: String? {
        text ?? (data?.value as? String)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: LLMContextCodingKey.self)
        let kindRaw = container.decodeString(for: ["kind", "type", "role"]) ?? "unknown"
        kind = LLMContextSectionKind(rawValue: kindRaw)
        label = container.decodeString(for: ["label", "title", "name", "heading"])
            ?? Self.defaultLabel(for: kind)
        role = container.decodeString(for: ["role"])
        toolName = container.decodeString(for: ["toolName", "tool_name"])
        language = container.decodeString(for: ["language", "syntax", "format"])
        collapsedByDefault = container.decodeBool(for: ["collapsedByDefault", "collapsed"])

        let legacyContent = container.decodeAnyCodable(for: ["content", "body", "value", "payload"])
        if let explicitText = container.decodeString(for: ["text"]) {
            text = explicitText
        } else if let legacyString = legacyContent?.value as? String {
            text = legacyString
        } else {
            text = nil
        }

        data = container.decodeAnyCodable(for: ["data"])
            ?? ((legacyContent?.value as? String) == nil ? legacyContent : nil)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: LLMContextCodingKey.self)
        try container.encode(kind, forKey: LLMContextCodingKey.key("kind"))
        try container.encode(label, forKey: LLMContextCodingKey.key("label"))
        try container.encodeIfPresent(role, forKey: "role")
        try container.encodeIfPresent(text, forKey: "text")
        try container.encodeIfPresent(toolName, forKey: "toolName")
        try container.encodeIfPresent(data, forKey: "data")
        try container.encodeIfPresent(language, forKey: "language")
        try container.encodeIfPresent(collapsedByDefault, forKey: "collapsedByDefault")
    }

    private static func defaultLabel(for kind: LLMContextSectionKind) -> String {
        switch kind {
        case .system:
            return "System prompt"
        case .message:
            return "Message"
        case .toolDefinitions:
            return "Available tools"
        case .toolUse:
            return "Tool use"
        case .toolResult:
            return "Tool result"
        case .functionCall:
            return "Function call"
        case .functionResponse:
            return "Function response"
        default:
            return "Section"
        }
    }
}

/// Section kind values returned by the normalized LLM context response.
public enum LLMContextSectionKind: Sendable, Codable, Equatable, CustomStringConvertible {
    case system
    case message
    case toolDefinitions
    case toolUse
    case toolResult
    case functionCall
    case functionResponse
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
        case .message: return "message"
        case .toolDefinitions: return "tool_definitions"
        case .toolUse: return "tool_use"
        case .toolResult: return "tool_result"
        case .functionCall: return "function_call"
        case .functionResponse: return "function_response"
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
        case "message":
            self = .message
        case "tool_definitions":
            self = .toolDefinitions
        case "tool_use":
            self = .toolUse
        case "tool_result":
            self = .toolResult
        case "function_call":
            self = .functionCall
        case "function_response":
            self = .functionResponse
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

    func decodeStringArray(for keys: [String]) -> [String]? {
        for key in keys {
            guard let codingKey = Key(stringValue: key) else { continue }
            if let value = try? decodeIfPresent([String].self, forKey: codingKey) {
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

    mutating func encodeIfPresent(_ value: [String]?, forKey key: String) throws {
        guard let value, let codingKey = Key(stringValue: key) else { return }
        try encode(value, forKey: codingKey)
    }
}

public struct MemoryRecallCandidate: Codable, Sendable, Equatable {
    public let key: String
    public let type: String
    public let kind: String
    public let finalScore: Double
    public let semantic: Double
    public let recency: Double
}

public struct MemoryRecallDegradation: Codable, Sendable, Equatable {
    public let semanticUnavailable: Bool
    public let reason: String
    public let fallbackSources: [String]
}

public struct MemoryRecallData: Codable, Sendable, Equatable {
    public let enabled: Bool
    public let degraded: Bool
    public let provider: String?
    public let model: String?
    public let degradation: MemoryRecallDegradation?
    public let semanticHits: Int
    public let mergedCount: Int
    public let selectedCount: Int
    public let tier1Count: Int
    public let tier2Count: Int
    public let hybridSearchLatencyMs: Int
    public let sparseVectorUsed: Bool
    public let injectedTokens: Int
    public let latencyMs: Int
    public let reason: String?
    public let topCandidates: [MemoryRecallCandidate]
    public let injectedText: String?
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
    public let memoryRecall: MemoryRecallData?
}

/// Explicit outcome for an LLM context fetch.
public enum LLMContextFetchResult: Sendable {
    case loaded(LLMContextResponse)
    case empty
    case failed
}

/// Focused client for fetching LLM request/response context for a given message,
/// routed through the gateway.
public protocol LLMContextClientProtocol {
    func fetchContext(messageId: String) async -> LLMContextResponse?
    func fetchContextResult(messageId: String) async throws -> LLMContextFetchResult
}

/// Gateway-backed implementation of ``LLMContextClientProtocol``.
public struct LLMContextClient: LLMContextClientProtocol {
    nonisolated public init() {}

    public func fetchContext(messageId: String) async -> LLMContextResponse? {
        do {
            switch try await fetchContextResult(messageId: messageId) {
            case .loaded(let response):
                return response
            case .empty, .failed:
                return nil
            }
        } catch is CancellationError {
            return nil
        } catch {
            log.error("fetchContext error: \(error.localizedDescription)")
            return nil
        }
    }

    public func fetchContextResult(messageId: String) async throws -> LLMContextFetchResult {
        do {
            try Task.checkCancellation()
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/messages/\(messageId)/llm-context",
                timeout: 15
            )
            try Task.checkCancellation()
            guard response.isSuccess else {
                log.error("fetchContext failed (HTTP \(response.statusCode))")
                return .failed
            }
            let decoded = try JSONDecoder().decode(LLMContextResponse.self, from: response.data)
            try Task.checkCancellation()
            return decoded.logs.isEmpty ? .empty : .loaded(decoded)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            if Task.isCancelled {
                throw CancellationError()
            }
            log.error("fetchContext error: \(error.localizedDescription)")
            return .failed
        }
    }
}

public extension LLMContextClientProtocol {
    func fetchContextResult(messageId: String) async throws -> LLMContextFetchResult {
        guard let response = await fetchContext(messageId: messageId) else {
            return .failed
        }

        return response.logs.isEmpty ? .empty : .loaded(response)
    }
}

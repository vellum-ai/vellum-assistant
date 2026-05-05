import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "LLMContextClient")

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
    public let estimatedCostUsd: Double?

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
        durationMs: Int? = nil,
        estimatedCostUsd: Double? = nil
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
        self.estimatedCostUsd = estimatedCostUsd
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
        estimatedCostUsd = container.decodeDouble(for: ["estimatedCostUsd", "estimated_cost_usd"])
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
        try container.encodeIfPresent(estimatedCostUsd, forKey: "estimatedCostUsd")
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

    func decodeDouble(for keys: [String]) -> Double? {
        for key in keys {
            guard let codingKey = Key(stringValue: key) else { continue }
            if let value = try? decodeIfPresent(Double.self, forKey: codingKey) {
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

    mutating func encodeIfPresent(_ value: Double?, forKey key: String) throws {
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
    public let nodeId: String
    public let type: String
    public let score: Double
    public let semanticSimilarity: Double
    public let recencyBoost: Double
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
    public let queryContext: String?
}

public struct MemoryV2ActivationData: Codable, Sendable, Equatable {
    public let turn: Int
    public let mode: String // "context-load" | "per-turn"
    /// All v2 entries scored for this turn, ranked together. Skill entries
    /// appear with a `slug` prefixed `skills/`; concept-page entries use
    /// their on-disk slug directly. Filtering on the prefix yields a
    /// skills-only or concepts-only view.
    public let concepts: [MemoryV2ConceptRow]
    public let config: MemoryV2Config

    public init(
        turn: Int,
        mode: String,
        concepts: [MemoryV2ConceptRow],
        config: MemoryV2Config
    ) {
        self.turn = turn
        self.mode = mode
        self.concepts = concepts
        self.config = config
    }

    private enum CodingKeys: String, CodingKey {
        case turn, mode, concepts, config
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        turn = try container.decode(Int.self, forKey: .turn)
        mode = try container.decode(String.self, forKey: .mode)
        concepts = try container.decode([MemoryV2ConceptRow].self, forKey: .concepts)
        config = try container.decode(MemoryV2Config.self, forKey: .config)
    }
}

public struct MemoryV2ConceptRow: Codable, Sendable, Equatable, Identifiable {
    public var id: String { slug }
    public let slug: String
    public let finalActivation: Double
    public let ownActivation: Double
    public let priorActivation: Double
    public let simUser: Double
    public let simAssistant: Double
    public let simNow: Double
    /// Portion of `simUser` contributed by the cross-encoder rerank step.
    /// Zero when rerank is disabled or the slug fell outside the top-K
    /// window. Older log rows that pre-date this field decode as 0.
    public let simUserRerankBoost: Double
    /// Portion of `simAssistant` contributed by the cross-encoder rerank
    /// step. Same semantics as `simUserRerankBoost`. NOW channel bypasses
    /// rerank, so there is no corresponding NOW boost.
    public let simAssistantRerankBoost: Double
    public let spreadContribution: Double
    public let source: String  // "prior_state" | "ann_top50" | "both"
    public let status: String  // "in_context" | "injected" | "not_injected"

    public init(
        slug: String,
        finalActivation: Double,
        ownActivation: Double,
        priorActivation: Double,
        simUser: Double,
        simAssistant: Double,
        simNow: Double,
        simUserRerankBoost: Double = 0,
        simAssistantRerankBoost: Double = 0,
        spreadContribution: Double,
        source: String,
        status: String
    ) {
        self.slug = slug
        self.finalActivation = finalActivation
        self.ownActivation = ownActivation
        self.priorActivation = priorActivation
        self.simUser = simUser
        self.simAssistant = simAssistant
        self.simNow = simNow
        self.simUserRerankBoost = simUserRerankBoost
        self.simAssistantRerankBoost = simAssistantRerankBoost
        self.spreadContribution = spreadContribution
        self.source = source
        self.status = status
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.slug = try c.decode(String.self, forKey: .slug)
        self.finalActivation = try c.decode(Double.self, forKey: .finalActivation)
        self.ownActivation = try c.decode(Double.self, forKey: .ownActivation)
        self.priorActivation = try c.decode(Double.self, forKey: .priorActivation)
        self.simUser = try c.decode(Double.self, forKey: .simUser)
        self.simAssistant = try c.decode(Double.self, forKey: .simAssistant)
        self.simNow = try c.decode(Double.self, forKey: .simNow)
        // Default to 0 so log rows written before the rerank-boost fields
        // were added still decode and render as "no boost" instead of
        // failing the whole inspector tab.
        self.simUserRerankBoost = try c.decodeIfPresent(Double.self, forKey: .simUserRerankBoost) ?? 0
        self.simAssistantRerankBoost = try c.decodeIfPresent(Double.self, forKey: .simAssistantRerankBoost) ?? 0
        self.spreadContribution = try c.decode(Double.self, forKey: .spreadContribution)
        self.source = try c.decode(String.self, forKey: .source)
        self.status = try c.decode(String.self, forKey: .status)
    }
}

public struct MemoryV2Config: Codable, Sendable, Equatable {
    public let d: Double
    public let cUser: Double
    public let cAssistant: Double
    public let cNow: Double
    public let k: Double
    public let hops: Int
    public let topK: Int
    public let epsilon: Double

    enum CodingKeys: String, CodingKey {
        case d, k, hops, epsilon
        case cUser = "c_user"
        case cAssistant = "c_assistant"
        case cNow = "c_now"
        case topK = "top_k"
    }

    public init(
        d: Double,
        cUser: Double,
        cAssistant: Double,
        cNow: Double,
        k: Double,
        hops: Int,
        topK: Int,
        epsilon: Double
    ) {
        self.d = d
        self.cUser = cUser
        self.cAssistant = cAssistant
        self.cNow = cNow
        self.k = k
        self.hops = hops
        self.topK = topK
        self.epsilon = epsilon
    }
}

/// A single LLM request/response log entry returned by the context endpoint.
/// `requestPayload` and `responsePayload` are nil in the initial response and
/// fetched on demand via the dedicated payload endpoint.
public struct LLMRequestLogEntry: Codable, Identifiable, Sendable {
    public let id: String
    public let requestPayload: AnyCodable?
    public let responsePayload: AnyCodable?
    public let createdAt: Int
    public let summary: LLMCallSummary?
    public let requestSections: [LLMContextSection]?
    public let responseSections: [LLMContextSection]?
}

/// Response from the dedicated log payload endpoint.
public struct LLMLogPayloadResponse: Codable, Sendable {
    public let id: String
    public let requestPayload: AnyCodable
    public let responsePayload: AnyCodable
}

/// Conversation kinds the daemon may report for an LLM-context lookup.
/// Wire raw values mirror the daemon's `CONVERSATION_KINDS` constant in
/// `assistant/src/runtime/routes/conversation-query-routes.ts`. Unknown
/// values from a newer daemon decode to `nil` rather than failing the
/// whole response.
public enum ConversationKind: String, Codable, Sendable, Equatable, Hashable {
    case user
    case background
    case backgroundMemoryConsolidation = "background_memory_consolidation"
    case scheduled
}

/// Response wrapper for the LLM context endpoint.
public struct LLMContextResponse: Codable, Sendable {
    public let messageId: String
    /// `nil` when the daemon predates the field or sends a value the client
    /// doesn't recognize — render the generic empty state in that case.
    public let conversationKind: ConversationKind?
    public let logs: [LLMRequestLogEntry]
    public let memoryRecall: MemoryRecallData?
    public let memoryV2Activation: MemoryV2ActivationData?

    public init(
        messageId: String,
        conversationKind: ConversationKind? = nil,
        logs: [LLMRequestLogEntry],
        memoryRecall: MemoryRecallData? = nil,
        memoryV2Activation: MemoryV2ActivationData? = nil
    ) {
        self.messageId = messageId
        self.conversationKind = conversationKind
        self.logs = logs
        self.memoryRecall = memoryRecall
        self.memoryV2Activation = memoryV2Activation
    }

    private enum CodingKeys: String, CodingKey {
        case messageId
        case conversationKind
        case logs
        case memoryRecall
        case memoryV2Activation
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.messageId = try container.decode(String.self, forKey: .messageId)
        // Lossy decode: unknown daemon kinds collapse to nil so the response
        // still parses and the inspector falls back to the generic empty state.
        let rawKind = try container.decodeIfPresent(String.self, forKey: .conversationKind)
        self.conversationKind = rawKind.flatMap(ConversationKind.init(rawValue:))
        self.logs = try container.decode([LLMRequestLogEntry].self, forKey: .logs)
        self.memoryRecall = try container.decodeIfPresent(MemoryRecallData.self, forKey: .memoryRecall)
        self.memoryV2Activation = try container.decodeIfPresent(MemoryV2ActivationData.self, forKey: .memoryV2Activation)
    }
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
    func fetchLogPayload(logId: String) async -> LLMLogPayloadResponse?
    /// Reads the raw rendered (frontmatter + body) markdown for a single
    /// memory v2 concept page. `nil` when the page has no on-disk file
    /// (e.g. stale activation log row referencing a deleted slug) or when
    /// the daemon is unreachable. The activation-log inspector lazy-fetches
    /// this on disclosure-row expansion.
    func fetchConceptPage(slug: String) async -> String?
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
        let response: GatewayHTTPClient.Response
        do {
            try Task.checkCancellation()
            response = try await GatewayHTTPClient.get(
                path: "messages/\(messageId)/llm-context",
                timeout: 15
            )
            try Task.checkCancellation()
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            if Task.isCancelled { throw CancellationError() }
            log.error("fetchContext network error: \(error.localizedDescription)")
            return .failed
        }

        guard response.isSuccess else {
            log.error("fetchContext failed (HTTP \(response.statusCode))")
            return .failed
        }

        do {
            let decoded = try JSONDecoder().decode(LLMContextResponse.self, from: response.data)
            try Task.checkCancellation()
            // Always return `.loaded` so the view state receives `conversationKind`
            // even when the log list is empty — the empty-state branch is derived
            // from `logs.isEmpty` inside `MessageInspectorViewState.finishLoading`.
            return .loaded(decoded)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            if Task.isCancelled { throw CancellationError() }
            log.error("fetchContext decode error: \(Self.describeDecodingError(error))")
            let snippet = String(data: response.data.prefix(2048), encoding: .utf8) ?? "<non-utf8>"
            log.error("fetchContext body prefix (\(response.data.count) bytes): \(snippet)")
            return .failed
        }
    }

    private static func describeDecodingError(_ error: Error) -> String {
        guard let decodingError = error as? DecodingError else {
            return error.localizedDescription
        }
        let path: String
        let detail: String
        switch decodingError {
        case .typeMismatch(let type, let context):
            path = context.codingPath.map(\.stringValue).joined(separator: ".")
            detail = "typeMismatch(\(type)) — \(context.debugDescription)"
        case .valueNotFound(let type, let context):
            path = context.codingPath.map(\.stringValue).joined(separator: ".")
            detail = "valueNotFound(\(type)) — \(context.debugDescription)"
        case .keyNotFound(let key, let context):
            path = context.codingPath.map(\.stringValue).joined(separator: ".")
            detail = "keyNotFound(\(key.stringValue)) — \(context.debugDescription)"
        case .dataCorrupted(let context):
            path = context.codingPath.map(\.stringValue).joined(separator: ".")
            detail = "dataCorrupted — \(context.debugDescription)"
        @unknown default:
            return decodingError.localizedDescription
        }
        return "at \(path.isEmpty ? "<root>" : path): \(detail)"
    }

    public func fetchLogPayload(logId: String) async -> LLMLogPayloadResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "llm-request-logs/\(logId)/payload",
                timeout: 30
            )
            guard response.isSuccess else {
                log.error("fetchLogPayload failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(LLMLogPayloadResponse.self, from: response.data)
        } catch {
            log.error("fetchLogPayload error: \(error.localizedDescription)")
            return nil
        }
    }

    public func fetchConceptPage(slug: String) async -> String? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "memory/v2/concept-page",
                json: ["slug": slug],
                timeout: 15
            )
            // 404 = page no longer on disk (stale slug). Surface as nil so
            // the inspector can render a "page missing" affordance instead
            // of treating it as a transport error.
            if response.statusCode == 404 { return nil }
            guard response.isSuccess else {
                log.error("fetchConceptPage failed (HTTP \(response.statusCode)) for slug \(slug)")
                return nil
            }
            let decoded = try JSONDecoder().decode(ConceptPageResponse.self, from: response.data)
            return decoded.rendered
        } catch is CancellationError {
            return nil
        } catch {
            log.error("fetchConceptPage error for slug \(slug): \(error.localizedDescription)")
            return nil
        }
    }
}

private struct ConceptPageResponse: Decodable {
    let slug: String
    let rendered: String
}

public extension LLMContextClientProtocol {
    func fetchContextResult(messageId: String) async throws -> LLMContextFetchResult {
        guard let response = await fetchContext(messageId: messageId) else {
            return .failed
        }

        return .loaded(response)
    }

    func fetchLogPayload(logId: String) async -> LLMLogPayloadResponse? {
        nil
    }

    func fetchConceptPage(slug: String) async -> String? {
        nil
    }
}

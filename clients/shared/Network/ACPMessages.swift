import Foundation

// MARK: - ACPSessionState

/// Runtime state of an Agent Client Protocol (ACP) session.
///
/// Mirrors `AcpSessionState` in `assistant/src/acp/types.ts`. The TypeScript
/// definition allows new `status` and `stopReason` literal values to be added
/// without bumping a wire version, so the Swift decoders fall back to
/// `.unknown` rather than failing — this keeps the client tolerant of daemon
/// version skew.
public struct ACPSessionState: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let agentId: String
    public let acpSessionId: String
    /// Conversation that spawned this session.
    public let parentConversationId: String?
    public let status: Status
    public let startedAt: Int
    public let completedAt: Int?
    public let error: String?
    public let stopReason: StopReason?

    public init(
        id: String,
        agentId: String,
        acpSessionId: String,
        parentConversationId: String? = nil,
        status: Status,
        startedAt: Int,
        completedAt: Int? = nil,
        error: String? = nil,
        stopReason: StopReason? = nil
    ) {
        self.id = id
        self.agentId = agentId
        self.acpSessionId = acpSessionId
        self.parentConversationId = parentConversationId
        self.status = status
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.error = error
        self.stopReason = stopReason
    }

    public enum Status: String, Codable, Equatable, Sendable {
        case initializing
        case running
        case completed
        case failed
        case cancelled
        case unknown

        /// Fall back to `.unknown` for unrecognized statuses so version skew
        /// between daemon and client never silently drops a session update.
        public init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            self = Status(rawValue: raw) ?? .unknown
        }
    }

    public enum StopReason: String, Codable, Equatable, Sendable {
        case endTurn = "end_turn"
        case maxTokens = "max_tokens"
        case maxTurnRequests = "max_turn_requests"
        case refusal
        case cancelled
        case unknown

        /// Fall back to `.unknown` for unrecognized stop reasons.
        public init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            self = StopReason(rawValue: raw) ?? .unknown
        }
    }
}

// MARK: - ACPSessionSpawnedMessage

/// Wire event: a new ACP session has been spawned.
///
/// Wire type: `"acp_session_spawned"`. Mirrors `AcpSessionSpawned` in
/// `assistant/src/daemon/message-types/acp.ts`. The discriminating `type`
/// field is consumed by `ServerMessage`'s top-level decoder, so it is not
/// re-decoded here.
public struct ACPSessionSpawnedMessage: Codable, Equatable, Sendable {
    public let acpSessionId: String
    public let agent: String
    public let parentConversationId: String

    public init(acpSessionId: String, agent: String, parentConversationId: String) {
        self.acpSessionId = acpSessionId
        self.agent = agent
        self.parentConversationId = parentConversationId
    }
}

// MARK: - ACPSessionUpdateMessage

/// Wire event: streaming update from an ACP session.
///
/// Wire type: `"acp_session_update"`. Mirrors `AcpSessionUpdate` in
/// `assistant/src/daemon/message-types/acp.ts`.
///
/// `id` is a SwiftUI-only stable identity for list diffing — generated
/// fresh on each decode/init and excluded from `CodingKeys`, so it does
/// not appear on the wire. Equality is content-based to keep two decodes
/// of the same payload comparable.
public struct ACPSessionUpdateMessage: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID = UUID()
    public let acpSessionId: String
    public let updateType: UpdateType
    public let content: String?
    public let toolCallId: String?
    public let toolTitle: String?
    public let toolKind: String?
    public let toolStatus: String?

    public init(
        acpSessionId: String,
        updateType: UpdateType,
        content: String? = nil,
        toolCallId: String? = nil,
        toolTitle: String? = nil,
        toolKind: String? = nil,
        toolStatus: String? = nil
    ) {
        self.acpSessionId = acpSessionId
        self.updateType = updateType
        self.content = content
        self.toolCallId = toolCallId
        self.toolTitle = toolTitle
        self.toolKind = toolKind
        self.toolStatus = toolStatus
    }

    public enum UpdateType: String, Codable, Equatable, Sendable {
        case agentMessageChunk = "agent_message_chunk"
        case agentThoughtChunk = "agent_thought_chunk"
        case userMessageChunk = "user_message_chunk"
        case toolCall = "tool_call"
        case toolCallUpdate = "tool_call_update"
        case plan
        case unknown

        /// Fall back to `.unknown` for unrecognized update types.
        public init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            self = UpdateType(rawValue: raw) ?? .unknown
        }
    }

    private enum CodingKeys: String, CodingKey {
        case acpSessionId
        case updateType
        case content
        case toolCallId
        case toolTitle
        case toolKind
        case toolStatus
    }

    public static func == (lhs: ACPSessionUpdateMessage, rhs: ACPSessionUpdateMessage) -> Bool {
        lhs.acpSessionId == rhs.acpSessionId
            && lhs.updateType == rhs.updateType
            && lhs.content == rhs.content
            && lhs.toolCallId == rhs.toolCallId
            && lhs.toolTitle == rhs.toolTitle
            && lhs.toolKind == rhs.toolKind
            && lhs.toolStatus == rhs.toolStatus
    }
}

// MARK: - ACPSessionCompletedMessage

/// Wire event: an ACP session has completed.
///
/// Wire type: `"acp_session_completed"`. Mirrors `AcpSessionCompleted` in
/// `assistant/src/daemon/message-types/acp.ts`.
public struct ACPSessionCompletedMessage: Codable, Equatable, Sendable {
    public let acpSessionId: String
    public let stopReason: ACPSessionState.StopReason

    public init(acpSessionId: String, stopReason: ACPSessionState.StopReason) {
        self.acpSessionId = acpSessionId
        self.stopReason = stopReason
    }
}

// MARK: - ACPSessionErrorMessage

/// Wire event: an ACP session encountered an error.
///
/// Wire type: `"acp_session_error"`. Mirrors `AcpSessionError` in
/// `assistant/src/daemon/message-types/acp.ts`.
public struct ACPSessionErrorMessage: Codable, Equatable, Sendable {
    public let acpSessionId: String
    public let error: String

    public init(acpSessionId: String, error: String) {
        self.acpSessionId = acpSessionId
        self.error = error
    }
}

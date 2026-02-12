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
    let interactionType: String?
}

/// Sent after each perceive step with AX tree, screenshot, and execution results.
/// Wire type: `"cu_observation"`
struct CuObservationMessage: Encodable, Sendable {
    let type: String = "cu_observation"
    let sessionId: String
    let axTree: String?
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
    let requestId: String
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
    let systemPromptOverride: String?
    let maxResponseTokens: Int?
    /// Client-generated nonce echoed back in `session_info` so the caller can
    /// correlate the response to its specific request. Prevents multiple
    /// ChatViewModels sharing one DaemonClient from stealing each other's sessions.
    let correlationId: String?

    init(title: String?, systemPromptOverride: String? = nil, maxResponseTokens: Int? = nil, correlationId: String? = nil) {
        self.title = title
        self.systemPromptOverride = systemPromptOverride
        self.maxResponseTokens = maxResponseTokens
        self.correlationId = correlationId
    }
}

/// Sent to add a user message to an existing Q&A session.
/// Wire type: `"user_message"`
struct UserMessageMessage: Encodable, Sendable {
    let type: String = "user_message"
    let sessionId: String
    let content: String
    let attachments: [IPCAttachment]?
}

/// Sent to request daemon-side classification and session creation.
/// Wire type: `"task_submit"`
struct TaskSubmitMessage: Encodable, Sendable {
    let type: String = "task_submit"
    let task: String
    let screenWidth: Int
    let screenHeight: Int
    let attachments: [IPCAttachment]?
    let source: String?
}

/// Sent to cancel the active generation.
/// Wire type: `"cancel"`
struct CancelMessage: Encodable, Sendable {
    let type: String = "cancel"
    let sessionId: String
}

/// Sent to abort a running computer-use session.
/// Wire type: `"cu_session_abort"`
struct CuSessionAbortMessage: Encodable, Sendable {
    let type: String = "cu_session_abort"
    let sessionId: String
}

/// Keepalive ping.
/// Wire type: `"ping"`
struct PingMessage: Encodable, Sendable {
    let type: String = "ping"
}

/// Sent when user interacts with a surface.
/// Wire type: `"ui_surface_action"`
struct UiSurfaceActionMessage: Encodable, Sendable {
    let type: String = "ui_surface_action"
    let sessionId: String
    let surfaceId: String
    let actionId: String
    let data: [String: AnyCodable]?
}

/// Sent when a persistent app's JS makes a data request via the RPC bridge.
/// Wire type: `"app_data_request"`
struct AppDataRequestMessage: Encodable, Sendable {
    let type: String = "app_data_request"
    let surfaceId: String
    let callId: String
    let method: String
    let appId: String
    let recordId: String?
    let data: [String: AnyCodable]?
}

/// Sent to request the list of available skills.
/// Wire type: `"skills_list"`
struct SkillsListRequestMessage: Encodable, Sendable {
    let type: String = "skills_list"
}

/// Sent to request the full body of a specific skill.
/// Wire type: `"skill_detail"`
struct SkillDetailRequestMessage: Encodable, Sendable {
    let type: String = "skill_detail"
    let skillId: String
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
    let isResponse: Bool?
}

/// Session-level error from the server.
struct CuErrorMessage: Decodable, Sendable {
    let sessionId: String
    let message: String
}

/// Streamed text delta from the assistant's response.
struct AssistantTextDeltaMessage: Decodable, Sendable {
    let text: String
    let sessionId: String?

    init(text: String, sessionId: String? = nil) {
        self.text = text
        self.sessionId = sessionId
    }
}

/// Streamed thinking delta from the assistant's reasoning.
struct AssistantThinkingDeltaMessage: Decodable, Sendable {
    let thinking: String
}

/// Signals that the assistant's message is complete.
struct MessageCompleteMessage: Decodable, Sendable {
    let sessionId: String?

    init(sessionId: String? = nil) {
        self.sessionId = sessionId
    }
}

/// Session metadata from the server (e.g. generated title).
struct SessionInfoMessage: Decodable, Sendable {
    let sessionId: String
    let title: String
    /// Echoed from the `session_create` request so the caller can match
    /// this response to its specific request.
    let correlationId: String?

    init(sessionId: String, title: String, correlationId: String? = nil) {
        self.sessionId = sessionId
        self.title = title
        self.correlationId = correlationId
    }
}

/// Daemon response after classifying and routing a task_submit.
struct TaskRoutedMessage: Decodable, Sendable {
    let sessionId: String
    let interactionType: String
    /// The task text passed to the escalated session.
    let task: String?
    /// Set when a text_qa session escalates to computer_use via request_computer_control.
    let escalatedFrom: String?
}

/// Result from ambient observation analysis.
struct AmbientResultMessage: Decodable, Sendable {
    let requestId: String
    let decision: String
    let summary: String?
    let suggestion: String?
}

/// Surface show command from daemon.
/// Wire type: `"ui_surface_show"`
struct UiSurfaceShowMessage: Decodable, Sendable {
    let sessionId: String
    let surfaceId: String
    let surfaceType: String
    let title: String?
    let data: AnyCodable
    let actions: [SurfaceActionData]?
}

struct SurfaceActionData: Decodable, Sendable {
    let id: String
    let label: String
    let style: String?
}

/// Surface update command from daemon.
/// Wire type: `"ui_surface_update"`
struct UiSurfaceUpdateMessage: Decodable, Sendable {
    let sessionId: String
    let surfaceId: String
    let data: AnyCodable
}

/// Surface dismiss command from daemon.
/// Wire type: `"ui_surface_dismiss"`
struct UiSurfaceDismissMessage: Decodable, Sendable {
    let sessionId: String
    let surfaceId: String
}

/// Confirms generation was cancelled.
struct GenerationCancelledMessage: Decodable, Sendable {
    let sessionId: String?
}

/// Notifies client that active generation yielded to queued work at a checkpoint.
/// Wire type: `"generation_handoff"`
struct GenerationHandoffMessage: Decodable, Sendable {
    let sessionId: String
    let requestId: String?
    let queuedCount: Int
}

/// Notifies client that a message has been queued for processing.
/// Wire type: `"message_queued"`
struct MessageQueuedMessage: Decodable, Sendable {
    let sessionId: String
    let requestId: String
    let position: Int
}

/// Notifies client that a queued message has been dequeued and is now being processed.
/// Wire type: `"message_dequeued"`
struct MessageDequeuedMessage: Decodable, Sendable {
    let sessionId: String
    let requestId: String
}

/// Server-level error message.
struct ErrorMessage: Decodable, Sendable {
    let message: String
}

/// Response from the daemon for a persistent app data request.
/// Wire type: `"app_data_response"`
struct AppDataResponseMessage: Decodable, Sendable {
    let surfaceId: String
    let callId: String
    let success: Bool
    let result: AnyCodable?
    let error: String?
}

/// A single skill summary item from the daemon's skill catalog.
struct SkillSummaryItem: Decodable, Sendable, Identifiable {
    let id: String
    let name: String
    let description: String
    let icon: String?
}

/// Response containing the list of available skills.
/// Wire type: `"skills_list_response"`
struct SkillsListResponseMessage: Decodable, Sendable {
    let skills: [SkillSummaryItem]
}

/// Response containing the full body of a specific skill.
/// Wire type: `"skill_detail_response"`
struct SkillDetailResponseMessage: Decodable, Sendable {
    let skillId: String
    let body: String
    let error: String?
}

/// Follow-up suggestion response from daemon.
/// Wire type: `"suggestion_response"`
struct SuggestionResponseMessage: Decodable, Sendable {
    let requestId: String
    let suggestion: String?
    let source: String
}

/// Permission confirmation request from daemon.
/// Wire type: `"confirmation_request"`
struct ConfirmationRequestMessage: Decodable, Sendable {
    let requestId: String
    let toolName: String
    let input: [String: AnyCodable]
    let riskLevel: String
    let allowlistOptions: [ConfirmationAllowlistOption]
    let scopeOptions: [ConfirmationScopeOption]
    let diff: ConfirmationDiffInfo?
    let sandboxed: Bool?

    struct ConfirmationAllowlistOption: Decodable, Sendable, Equatable {
        let label: String
        let pattern: String
    }
    struct ConfirmationScopeOption: Decodable, Sendable, Equatable {
        let label: String
        let scope: String
    }
    struct ConfirmationDiffInfo: Decodable, Sendable, Equatable {
        let filePath: String
        let oldContent: String
        let newContent: String
        let isNewFile: Bool
    }
}

/// Request a follow-up suggestion for the current session.
/// Wire type: `"suggestion_request"`
struct SuggestionRequestMessage: Encodable, Sendable {
    let type: String = "suggestion_request"
    let sessionId: String
    let requestId: String
}

/// Client response to a permission confirmation request.
/// Wire type: `"confirmation_response"`
struct ConfirmationResponseMessage: Encodable, Sendable {
    let type: String = "confirmation_response"
    let requestId: String
    let decision: String
    let selectedPattern: String?
    let selectedScope: String?
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
    case taskRouted(TaskRoutedMessage)
    case error(ErrorMessage)
    case ambientResult(AmbientResultMessage)
    case uiSurfaceShow(UiSurfaceShowMessage)
    case uiSurfaceUpdate(UiSurfaceUpdateMessage)
    case uiSurfaceDismiss(UiSurfaceDismissMessage)
    case generationCancelled(GenerationCancelledMessage)
    case generationHandoff(GenerationHandoffMessage)
    case confirmationRequest(ConfirmationRequestMessage)
    case appDataResponse(AppDataResponseMessage)
    case messageQueued(MessageQueuedMessage)
    case messageDequeued(MessageDequeuedMessage)
    case skillsListResponse(SkillsListResponseMessage)
    case skillDetailResponse(SkillDetailResponseMessage)
    case suggestionResponse(SuggestionResponseMessage)
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
        case "task_routed":
            let message = try TaskRoutedMessage(from: decoder)
            self = .taskRouted(message)
        case "error":
            let message = try ErrorMessage(from: decoder)
            self = .error(message)
        case "ambient_result":
            let message = try AmbientResultMessage(from: decoder)
            self = .ambientResult(message)
        case "ui_surface_show":
            let message = try UiSurfaceShowMessage(from: decoder)
            self = .uiSurfaceShow(message)
        case "ui_surface_update":
            let message = try UiSurfaceUpdateMessage(from: decoder)
            self = .uiSurfaceUpdate(message)
        case "ui_surface_dismiss":
            let message = try UiSurfaceDismissMessage(from: decoder)
            self = .uiSurfaceDismiss(message)
        case "generation_cancelled":
            let message = try GenerationCancelledMessage(from: decoder)
            self = .generationCancelled(message)
        case "generation_handoff":
            let message = try GenerationHandoffMessage(from: decoder)
            self = .generationHandoff(message)
        case "confirmation_request":
            let message = try ConfirmationRequestMessage(from: decoder)
            self = .confirmationRequest(message)
        case "app_data_response":
            let message = try AppDataResponseMessage(from: decoder)
            self = .appDataResponse(message)
        case "message_queued":
            let message = try MessageQueuedMessage(from: decoder)
            self = .messageQueued(message)
        case "message_dequeued":
            let message = try MessageDequeuedMessage(from: decoder)
            self = .messageDequeued(message)
        case "skills_list_response":
            let message = try SkillsListResponseMessage(from: decoder)
            self = .skillsListResponse(message)
        case "skill_detail_response":
            let message = try SkillDetailResponseMessage(from: decoder)
            self = .skillDetailResponse(message)
        case "suggestion_response":
            let message = try SuggestionResponseMessage(from: decoder)
            self = .suggestionResponse(message)
        case "pong":
            self = .pong
        default:
            self = .unknown(type)
        }
    }
}

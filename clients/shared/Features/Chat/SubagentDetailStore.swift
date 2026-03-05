import Foundation
import Observation
import os

/// Represents a single event in a subagent's activity stream.
public struct SubagentEventItem: Identifiable {
    public let id = UUID()
    public let timestamp: Date

    public enum Kind {
        case text
        case toolUse(name: String)
        case toolResult(isError: Bool)
        case error

        public var isError: Bool {
            if case .error = self { return true }
            return false
        }
    }

    public let kind: Kind
    public var content: String

    /// When a toolUse event is paired with its subsequent toolResult, the result content is attached here.
    public var resultContent: String?
    /// Whether the attached result is an error.
    public var resultIsError: Bool

    public init(timestamp: Date, kind: Kind, content: String, resultContent: String? = nil, resultIsError: Bool = false) {
        self.timestamp = timestamp
        self.kind = kind
        self.content = content
        self.resultContent = resultContent
        self.resultIsError = resultIsError
    }
}

/// Aggregated usage stats for a subagent session.
public struct SubagentUsageStats {
    public var inputTokens: Int
    public var outputTokens: Int
    public var estimatedCost: Double

    public init(inputTokens: Int = 0, outputTokens: Int = 0, estimatedCost: Double = 0) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.estimatedCost = estimatedCost
    }
}

/// Stores subagent detail data (events, objectives, usage) for display in the side panel.
///
/// Uses the Observation framework (`@Observable`) so SwiftUI tracks property
/// access at the view level — only views that read a specific subagent's events
/// are invalidated when that data changes, avoiding whole-list re-layout.
@MainActor @Observable
public final class SubagentDetailStore {
    /// Maximum number of events retained per subagent to prevent unbounded memory growth.
    static let eventRetentionCap = 500
    /// Maximum UTF-8 byte count for accumulated text content before truncation.
    static let textByteCap = 50_000

    public var eventsBySubagent: [String: [SubagentEventItem]] = [:]
    public var objectives: [String: String] = [:]
    public var usageStats: [String: SubagentUsageStats] = [:]

    // MARK: - Debug publish-rate counters

    #if DEBUG
    @ObservationIgnored
    private static let perfLog = OSLog(subsystem: "com.vellum.assistant", category: "PerfCounters")
    @ObservationIgnored
    private var mutationCount = 0
    @ObservationIgnored
    private var lastRateLogTime = Date()

    private func trackMutation() {
        mutationCount += 1
        let now = Date()
        if now.timeIntervalSince(lastRateLogTime) >= 5 {
            os_log(.debug, log: Self.perfLog, "SubagentDetailStore mutation rate: %d/5s", mutationCount)
            mutationCount = 0
            lastRateLogTime = now
        }
    }
    #endif

    public init() {}

    /// Record that a subagent was spawned with an objective.
    public func recordSpawned(subagentId: String, objective: String) {
        objectives[subagentId] = objective
        if eventsBySubagent[subagentId] == nil {
            eventsBySubagent[subagentId] = []
        }
        #if DEBUG
        trackMutation()
        #endif
    }

    /// Record a status change with optional usage stats.
    public func recordStatusChanged(subagentId: String, usage: IPCUsageStats?) {
        if let usage {
            usageStats[subagentId] = SubagentUsageStats(
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                estimatedCost: usage.estimatedCost
            )
            #if DEBUG
            trackMutation()
            #endif
        }
    }

    /// Handle a subagent event (forwarded ServerMessage from the subagent's session).
    public func handleEvent(subagentId: String, event: ServerMessage) {
        switch event {
        case .assistantTextDelta(let delta):
            // Accumulate text into the last event only if it's a text event
            if var events = eventsBySubagent[subagentId],
               let last = events.last,
               case .text = last.kind {
                var content = events[events.count - 1].content
                // Stop accumulating once text has been capped.
                guard content.utf8.count <= Self.textByteCap else { return }
                content += delta.text
                // Cap text concatenation to prevent unbounded string accumulation.
                if content.utf8.count > Self.textByteCap {
                    content = String(content.prefix(Self.textByteCap)) + " [truncated]"
                }
                events[events.count - 1].content = content
                eventsBySubagent[subagentId] = events
            } else {
                var text = delta.text
                if text.utf8.count > Self.textByteCap {
                    text = String(text.prefix(Self.textByteCap)) + " [truncated]"
                }
                let item = SubagentEventItem(timestamp: Date(), kind: .text, content: text)
                eventsBySubagent[subagentId, default: []].append(item)
                trimEvents(for: subagentId)
            }
            #if DEBUG
            trackMutation()
            #endif

        case .toolUseStart(let msg):
            let item = SubagentEventItem(
                timestamp: Date(),
                kind: .toolUse(name: msg.toolName),
                content: summarizeToolInput(msg.input)
            )
            eventsBySubagent[subagentId, default: []].append(item)
            trimEvents(for: subagentId)
            #if DEBUG
            trackMutation()
            #endif

        case .toolResult(let msg):
            let truncated = msg.result.count > 500 ? String(msg.result.prefix(497)) + "..." : msg.result
            let item = SubagentEventItem(
                timestamp: Date(),
                kind: .toolResult(isError: msg.isError ?? false),
                content: truncated
            )
            eventsBySubagent[subagentId, default: []].append(item)
            trimEvents(for: subagentId)
            #if DEBUG
            trackMutation()
            #endif

        case .error(let err):
            let item = SubagentEventItem(
                timestamp: Date(),
                kind: .error,
                content: err.message
            )
            eventsBySubagent[subagentId, default: []].append(item)
            trimEvents(for: subagentId)
            #if DEBUG
            trackMutation()
            #endif

        default:
            break
        }
    }

    /// Trim events for a subagent to stay within the retention cap.
    private func trimEvents(for subagentId: String) {
        guard var events = eventsBySubagent[subagentId],
              events.count > Self.eventRetentionCap else { return }
        events.removeFirst(events.count - Self.eventRetentionCap)
        eventsBySubagent[subagentId] = events
    }

    /// Populate events from a lazy-loaded `subagent_detail_response`.
    public func populateFromDetailResponse(_ response: IPCSubagentDetailResponse) {
        let subagentId = response.subagentId
        if let objective = response.objective {
            objectives[subagentId] = objective
        }
        // Only populate if we don't already have events (avoid duplicates on re-open)
        guard (eventsBySubagent[subagentId] ?? []).isEmpty else { return }
        if eventsBySubagent[subagentId] == nil {
            eventsBySubagent[subagentId] = []
        }
        for event in response.events {
            switch event.type {
            case "text":
                handleEvent(
                    subagentId: subagentId,
                    event: .assistantTextDelta(IPCAssistantTextDelta(type: "assistant_text_delta", text: event.content, sessionId: nil))
                )
            case "tool_use":
                let input: [String: AnyCodable]
                if let data = event.content.data(using: .utf8),
                   let parsed = try? JSONDecoder().decode([String: AnyCodable].self, from: data) {
                    input = parsed
                } else {
                    input = [:]
                }
                handleEvent(
                    subagentId: subagentId,
                    event: .toolUseStart(IPCToolUseStart(type: "tool_use_start", toolName: event.toolName ?? "unknown", input: input, sessionId: nil))
                )
            case "tool_result":
                handleEvent(
                    subagentId: subagentId,
                    event: .toolResult(IPCToolResult(type: "tool_result", toolName: event.toolName ?? "unknown", result: event.content, isError: event.isError, diff: nil, status: nil, sessionId: nil, imageData: nil))
                )
            default:
                break
            }
        }
    }

    /// Simple tool input summary for subagent event display.
    private func summarizeToolInput(_ input: [String: AnyCodable]) -> String {
        let priorityKeys = ["command", "file_path", "path", "query", "url", "pattern", "glob"]
        if let key = priorityKeys.first(where: { input[$0] != nil }),
           let value = input[key],
           let str = value.value as? String {
            return str.count > 120 ? String(str.prefix(117)) + "..." : str
        }
        return ""
    }
}

import Foundation

/// Represents a single event in a subagent's activity stream.
public struct SubagentEventItem: Identifiable {
    public let id = UUID()
    public let timestamp: Date

    public enum Kind {
        case text
        case toolUse(name: String)
        case toolResult(isError: Bool)
        case error
    }

    public let kind: Kind
    public var content: String
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
@MainActor
public final class SubagentDetailStore: ObservableObject {
    @Published public var eventsBySubagent: [String: [SubagentEventItem]] = [:]
    @Published public var objectives: [String: String] = [:]
    @Published public var usageStats: [String: SubagentUsageStats] = [:]

    public init() {}

    /// Record that a subagent was spawned with an objective.
    public func recordSpawned(subagentId: String, objective: String) {
        objectives[subagentId] = objective
        if eventsBySubagent[subagentId] == nil {
            eventsBySubagent[subagentId] = []
        }
    }

    /// Record a status change with optional usage stats.
    public func recordStatusChanged(subagentId: String, usage: IPCUsageStats?) {
        if let usage {
            usageStats[subagentId] = SubagentUsageStats(
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                estimatedCost: usage.estimatedCost
            )
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
                events[events.count - 1].content += delta.text
                eventsBySubagent[subagentId] = events
            } else {
                let item = SubagentEventItem(timestamp: Date(), kind: .text, content: delta.text)
                eventsBySubagent[subagentId, default: []].append(item)
            }

        case .toolUseStart(let msg):
            let item = SubagentEventItem(
                timestamp: Date(),
                kind: .toolUse(name: msg.toolName),
                content: summarizeToolInput(msg.input)
            )
            eventsBySubagent[subagentId, default: []].append(item)

        case .toolResult(let msg):
            let truncated = msg.result.count > 500 ? String(msg.result.prefix(497)) + "..." : msg.result
            let item = SubagentEventItem(
                timestamp: Date(),
                kind: .toolResult(isError: msg.isError ?? false),
                content: truncated
            )
            eventsBySubagent[subagentId, default: []].append(item)

        case .error(let err):
            let item = SubagentEventItem(
                timestamp: Date(),
                kind: .error,
                content: err.message
            )
            eventsBySubagent[subagentId, default: []].append(item)

        default:
            break
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

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

/// Per-subagent observable state. Each subagent gets its own instance so
/// SwiftUI tracks observation at the individual-subagent level. Mutating
/// one subagent's `events` only invalidates views that read that specific
/// `SubagentState`, leaving other subagent rows untouched.
@MainActor @Observable
public final class SubagentState {
    public var events: [SubagentEventItem] = []
    public var objective: String?
    public var usageStats: SubagentUsageStats?

    public init() {}
}

/// Stores subagent detail data (events, objectives, usage) for display in the side panel.
///
/// Each subagent's data lives in a separate `SubagentState` object so SwiftUI
/// observation is per-subagent: mutating one subagent's events only invalidates
/// views reading that `SubagentState`, not every subagent row.
///
/// High-frequency mutations (e.g. per-token `assistantTextDelta`) are buffered
/// in `@ObservationIgnored` staging dictionaries and flushed to the per-subagent
/// state objects once per 100ms coalescing window, per AGENTS.md requirements.
@MainActor @Observable
public final class SubagentDetailStore {
    /// Maximum number of events retained per subagent to prevent unbounded memory growth.
    static let eventRetentionCap = 500
    /// Maximum UTF-8 byte count for accumulated text content before truncation.
    static let textByteCap = 50_000
    /// Coalescing window for flushing staged mutations to observed properties.
    static let coalesceInterval: UInt64 = 100_000_000 // 100ms in nanoseconds

    /// Per-subagent observable state. The dictionary is only mutated when a new
    /// subagent is spawned (infrequent); streaming updates go through each
    /// `SubagentState`'s properties without touching the dictionary.
    public var subagentStates: [String: SubagentState] = [:]

    // MARK: - Staging buffers (untracked by Observation)

    /// Staged event mutations accumulate here between flushes.
    @ObservationIgnored
    private var stagedEvents: [String: [SubagentEventItem]] = [:]
    /// Staged objective updates accumulate here between flushes.
    @ObservationIgnored
    private var stagedObjectives: [String: String] = [:]
    /// Staged usage stat updates accumulate here between flushes.
    @ObservationIgnored
    private var stagedUsage: [String: SubagentUsageStats] = [:]
    /// The coalescing flush task; non-nil while a flush is scheduled.
    @ObservationIgnored
    private var flushTask: Task<Void, Never>?

    // MARK: - Debug publish-rate counters

    #if DEBUG
    @ObservationIgnored
    private static let perfLog = OSLog(subsystem: "com.vellum.assistant", category: "PerfCounters")
    @ObservationIgnored
    private var mutationCount = 0
    @ObservationIgnored
    private var flushCount = 0
    @ObservationIgnored
    private var lastRateLogTime = Date()

    private func trackMutation() {
        mutationCount += 1
        let now = Date()
        if now.timeIntervalSince(lastRateLogTime) >= 5 {
            os_log(
                .debug, log: Self.perfLog,
                "SubagentDetailStore mutations: %d, flushes: %d (per 5s)",
                mutationCount, flushCount
            )
            mutationCount = 0
            flushCount = 0
            lastRateLogTime = now
        }
    }
    #endif

    public init() {}

    deinit {
        flushTask?.cancel()
        flushTask = nil
    }

    // MARK: - Coalescing flush

    /// Schedule a flush of staged data into observed properties after the coalescing interval.
    /// The first mutation in a burst schedules the flush; subsequent mutations within the
    /// window piggyback on the same flush.
    private func scheduleFlush() {
        guard flushTask == nil else { return }
        flushTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.coalesceInterval)
            guard !Task.isCancelled else { return }
            self?.flush()
            self?.flushTask = nil
        }
    }

    /// Copy all staged mutations into the per-subagent state objects,
    /// triggering observation notifications only on the affected subagents.
    private func flush() {
        if !stagedObjectives.isEmpty {
            for (id, objective) in stagedObjectives {
                resolveState(for: id).objective = objective
            }
            stagedObjectives.removeAll(keepingCapacity: true)
        }

        if !stagedUsage.isEmpty {
            for (id, stats) in stagedUsage {
                resolveState(for: id).usageStats = stats
            }
            stagedUsage.removeAll(keepingCapacity: true)
        }

        if !stagedEvents.isEmpty {
            for (subagentId, events) in stagedEvents {
                resolveState(for: subagentId).events = events
            }
            stagedEvents.removeAll(keepingCapacity: true)
        }

        #if DEBUG
        flushCount += 1
        #endif
    }

    /// Returns the existing `SubagentState` for `subagentId`, creating one if needed.
    /// Dictionary mutation only occurs the first time a subagent is seen.
    private func resolveState(for subagentId: String) -> SubagentState {
        if let existing = subagentStates[subagentId] {
            return existing
        }
        let state = SubagentState()
        subagentStates[subagentId] = state
        return state
    }

    // MARK: - Staging helpers

    /// Returns the current working copy of events for a subagent,
    /// preferring the staged version over the last-flushed observed version.
    private func currentEvents(for subagentId: String) -> [SubagentEventItem] {
        stagedEvents[subagentId] ?? subagentStates[subagentId]?.events ?? []
    }

    /// Write events back to the staging buffer and schedule a flush.
    private func stageEvents(_ events: [SubagentEventItem], for subagentId: String) {
        stagedEvents[subagentId] = events
        scheduleFlush()
    }

    /// Trim staged events to stay within the retention cap.
    private func trimStagedEvents(for subagentId: String) {
        guard var events = stagedEvents[subagentId],
              events.count > Self.eventRetentionCap else { return }
        events.removeFirst(events.count - Self.eventRetentionCap)
        stagedEvents[subagentId] = events
    }

    /// Record that a subagent was spawned with an objective.
    public func recordSpawned(subagentId: String, objective: String) {
        // Eagerly create the state object so views can reference it immediately.
        // This is the only place the dictionary is mutated (infrequent).
        if subagentStates[subagentId] == nil {
            subagentStates[subagentId] = SubagentState()
        }
        stagedObjectives[subagentId] = objective
        if stagedEvents[subagentId] == nil {
            stagedEvents[subagentId] = []
        }
        scheduleFlush()
        #if DEBUG
        trackMutation()
        #endif
    }

    /// Record a status change with optional usage stats.
    public func recordStatusChanged(subagentId: String, usage: UsageStats?) {
        if let usage {
            stagedUsage[subagentId] = SubagentUsageStats(
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                estimatedCost: usage.estimatedCost
            )
            scheduleFlush()
            #if DEBUG
            trackMutation()
            #endif
        }
    }

    /// Handle a subagent event (forwarded ServerMessage from the subagent's session).
    public func handleEvent(subagentId: String, event: ServerMessage) {
        switch event {
        case .assistantTextDelta(let delta):
            var events = currentEvents(for: subagentId)
            if let last = events.last, case .text = last.kind {
                var content = events[events.count - 1].content
                guard content.utf8.count <= Self.textByteCap else { return }
                content += delta.text
                if content.utf8.count > Self.textByteCap {
                    content = String(content.prefix(Self.textByteCap)) + " [truncated]"
                }
                events[events.count - 1].content = content
            } else {
                var text = delta.text
                if text.utf8.count > Self.textByteCap {
                    text = String(text.prefix(Self.textByteCap)) + " [truncated]"
                }
                events.append(SubagentEventItem(timestamp: Date(), kind: .text, content: text))
            }
            stageEvents(events, for: subagentId)
            trimStagedEvents(for: subagentId)
            #if DEBUG
            trackMutation()
            #endif

        case .toolUseStart(let msg):
            let item = SubagentEventItem(
                timestamp: Date(),
                kind: .toolUse(name: msg.toolName),
                content: summarizeToolInput(msg.input)
            )
            var events = currentEvents(for: subagentId)
            events.append(item)
            stageEvents(events, for: subagentId)
            trimStagedEvents(for: subagentId)
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
            var events = currentEvents(for: subagentId)
            events.append(item)
            stageEvents(events, for: subagentId)
            trimStagedEvents(for: subagentId)
            #if DEBUG
            trackMutation()
            #endif

        case .error(let err):
            let item = SubagentEventItem(
                timestamp: Date(),
                kind: .error,
                content: err.message
            )
            var events = currentEvents(for: subagentId)
            events.append(item)
            stageEvents(events, for: subagentId)
            trimStagedEvents(for: subagentId)
            #if DEBUG
            trackMutation()
            #endif

        default:
            break
        }
    }

    /// Populate events from a lazy-loaded `subagent_detail_response`.
    /// This is a one-time bulk load that goes through the normal staging path
    /// so that the coalescing flush batches all events into a single update.
    public func populateFromDetailResponse(_ response: SubagentDetailResponse) {
        let subagentId = response.subagentId
        if let objective = response.objective {
            stagedObjectives[subagentId] = objective
            scheduleFlush()
        }
        // Only populate if we don't already have events (avoid duplicates on re-open)
        let existing = currentEvents(for: subagentId)
        guard existing.isEmpty else { return }
        if stagedEvents[subagentId] == nil && (subagentStates[subagentId]?.events ?? []).isEmpty {
            stagedEvents[subagentId] = []
        }
        for event in response.events {
            switch event.type {
            case "text":
                handleEvent(
                    subagentId: subagentId,
                    event: .assistantTextDelta(AssistantTextDelta(type: "assistant_text_delta", text: event.content, conversationId: nil))
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
                    event: .toolUseStart(ToolUseStart(type: "tool_use_start", toolName: event.toolName ?? "unknown", input: input, conversationId: nil))
                )
            case "tool_result":
                handleEvent(
                    subagentId: subagentId,
                    event: .toolResult(ToolResult(type: "tool_result", toolName: event.toolName ?? "unknown", result: event.content, isError: event.isError, diff: nil, status: nil, conversationId: nil, imageData: nil))
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

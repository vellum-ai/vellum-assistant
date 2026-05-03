import Foundation
import VellumAssistantShared

// MARK: - Progress Card Phase

/// Pure enum representing the current phase of assistant progress.
/// Mirrors the private `ProgressPhase` in `AssistantProgressView` so that later
/// refactors can swap the view's inline derivation for this standalone model
/// without changing phase semantics.
enum ProgressCardPhase: Equatable, Sendable {
    case thinking
    case toolRunning
    case streamingCode
    case toolsCompleteThinking
    case processing
    case complete
    case denied
}

// MARK: - Progress Card Presentation Model

/// Pure value model that captures all derived state needed to render a progress
/// card. Produced by a single O(n) pass over tool calls — no SwiftUI state, no
/// `@State`, no environment reads. The view layer can consume this as a plain
/// value and remain a thin rendering shell.
///
/// This mirrors the current `DerivedProgressState` + phase computation in
/// `AssistantProgressView` so that later PRs can adopt it without behavioral
/// change.
struct ProgressCardPresentationModel: Equatable {

    // MARK: - Tool Aggregates

    /// Whether every tool call in the group has completed.
    let allComplete: Bool
    /// Whether the group contains at least one tool call.
    let hasTools: Bool
    /// Number of tool calls that have finished (regardless of success/failure).
    let completedToolCount: Int
    /// Number of tool calls whose confirmation was denied or timed out.
    let deniedCount: Int
    /// Whether any tool call was denied or timed out (includes decidedConfirmations fallback).
    let hasDeniedToolCalls: Bool
    /// Whether any tool call currently has a pending confirmation request.
    let hasPendingConfirmation: Bool
    /// Whether any completed tool call has been stripped of its heavy content
    /// (all detail fields cleared by `stripHeavyContent`).
    let hasStrippedToolCalls: Bool
    /// Total number of tool calls in the group.
    let totalToolCount: Int

    // MARK: - Identity & Ordering

    /// Stable group identifier derived from the first tool call's UUID.
    /// Falls back to `"no-tools"` when the group is empty.
    let groupId: String
    /// The first incomplete tool call in iteration order, used for the
    /// "currently running" headline.
    let currentCall: ToolCallData?
    /// The very last tool call in the array (by position, not time).
    let lastToolCall: ToolCallData?
    /// The last incomplete tool call in iteration order.
    let lastIncompleteCall: ToolCallData?

    // MARK: - Display Metadata

    /// Human-friendly label for skill_execute tool calls, derived from the
    /// last completed `skill_load`'s input.
    let skillExecuteLabel: String
    /// Sorted array of unique tool names present in the group.
    let uniqueToolNamesSorted: [String]

    // MARK: - Timestamps

    /// Earliest `startedAt` across all tool calls in the group.
    let earliestStartedAt: Date?
    /// Latest `completedAt` across all tool calls in the group.
    let latestCompletedAt: Date?

    // MARK: - Computed Phase

    /// The resolved progress phase given the streaming/processing context.
    let phase: ProgressCardPhase

    /// Whether the card is in an active (animating) state.
    var isActive: Bool {
        switch phase {
        case .thinking, .toolRunning, .streamingCode, .toolsCompleteThinking, .processing:
            return true
        case .complete, .denied:
            return false
        }
    }

    // MARK: - Auto-Expand

    /// Whether the card should auto-expand on initial presentation, taking into
    /// account the `expand-completed-steps` feature flag and pending confirmations.
    let shouldAutoExpand: Bool

    // MARK: - Builder

    /// Streaming/processing context passed alongside tool calls to resolve the phase.
    struct StreamingContext: Equatable, Sendable {
        let isStreaming: Bool
        let hasText: Bool
        let isProcessing: Bool
        let streamingCodePreview: String?

        static let idle = StreamingContext(
            isStreaming: false,
            hasText: false,
            isProcessing: false,
            streamingCodePreview: nil
        )
    }

    /// Builds a presentation model from the raw tool call array and streaming
    /// context in a single O(n) pass. This is a pure function with no side
    /// effects — safe to call from any thread.
    ///
    /// - Parameters:
    ///   - toolCalls: The ordered array of tool calls in this progress group.
    ///   - decidedConfirmations: Confirmation decisions that may not yet be
    ///     reflected on individual tool calls.
    ///   - context: Current streaming/processing state of the message.
    ///   - expandCompletedStepsFlag: Value of the `expand-completed-steps`
    ///     feature flag. Passed explicitly to keep the builder pure.
    static func build(
        toolCalls: [ToolCallData],
        decidedConfirmations: [ToolConfirmationData],
        context: StreamingContext,
        expandCompletedStepsFlag: Bool = false
    ) -> ProgressCardPresentationModel {
        // --- Single O(n) pass over tool calls ---

        var allComplete = true
        let hasTools = !toolCalls.isEmpty
        var completedToolCount = 0
        var deniedCount = 0
        var hasDeniedToolCalls = false
        var hasPendingConfirmation = false
        var currentCall: ToolCallData?
        var lastIncompleteCall: ToolCallData?
        var lastSkillLoad: ToolCallData?
        var toolNameSet = Set<String>()
        var earliestStart: Date?
        var latestEnd: Date?
        var foundFirstIncomplete = false

        for toolCall in toolCalls {
            // Track completion
            if toolCall.isComplete {
                completedToolCount += 1
            } else {
                allComplete = false
                if !foundFirstIncomplete {
                    currentCall = toolCall
                    foundFirstIncomplete = true
                }
                lastIncompleteCall = toolCall
            }

            // Track denied/timed-out
            if toolCall.confirmationDecision == .denied || toolCall.confirmationDecision == .timedOut {
                deniedCount += 1
                hasDeniedToolCalls = true
            }

            // Track pending confirmations
            if toolCall.pendingConfirmation != nil {
                hasPendingConfirmation = true
            }

            // Track unique tool names
            toolNameSet.insert(toolCall.toolName)

            // Track skill_load (last completed one)
            if toolCall.toolName == "skill_load" && toolCall.isComplete {
                lastSkillLoad = toolCall
            }

            // Track timestamps
            if let started = toolCall.startedAt {
                if earliestStart == nil || started < earliestStart! {
                    earliestStart = started
                }
            }
            if let completed = toolCall.completedAt {
                if latestEnd == nil || completed > latestEnd! {
                    latestEnd = completed
                }
            }
        }

        let resolvedAllComplete = !toolCalls.isEmpty && allComplete
        let groupId = toolCalls.first?.id.uuidString ?? "no-tools"

        // Derive skill execute label
        var skillExecuteLabel = "Using a skill"
        if let skillLoad = lastSkillLoad,
           let skillId = skillLoad.inputRawDict?["skill"]?.value as? String,
           !skillId.isEmpty {
            let display = skillId
                .replacingOccurrences(of: "-", with: " ")
                .replacingOccurrences(of: "_", with: " ")
            skillExecuteLabel = "Using my \(display) skill"
        }

        // Whether any completed tool call has had its heavy content stripped
        let hasStrippedToolCalls = toolCalls.contains { tc in
            tc.isComplete
                && tc.inputFull.isEmpty
                && tc.result == nil
                && tc.inputRawDict == nil
                && tc.cachedImages.isEmpty
        }

        // Check decidedConfirmations for denied state (fallback)
        if !hasDeniedToolCalls {
            for confirmation in decidedConfirmations {
                if confirmation.state == .denied || confirmation.state == .timedOut {
                    hasDeniedToolCalls = true
                    break
                }
            }
        }

        // --- Phase resolution ---
        let phase = resolvePhase(
            hasTools: hasTools,
            allComplete: resolvedAllComplete,
            hasDeniedToolCalls: hasDeniedToolCalls,
            isStreaming: context.isStreaming,
            hasText: context.hasText,
            isProcessing: context.isProcessing,
            streamingCodePreview: context.streamingCodePreview
        )

        // --- Auto-expand ---
        // Matches the original AssistantProgressView logic: auto-expand fires when all
        // tools are complete, or when incomplete tools were denied/timed out. Phase-based
        // checks are narrower — .processing and .toolsCompleteThinking both imply
        // allComplete=true but are excluded by a `phase == .complete` match, which
        // silently dropped auto-expand for those states.
        let isComplete = hasTools && resolvedAllComplete
        let isDenied = hasDeniedToolCalls && hasTools && !resolvedAllComplete
        let shouldAutoExpand = ((isComplete || isDenied) && expandCompletedStepsFlag) || hasPendingConfirmation

        return ProgressCardPresentationModel(
            allComplete: resolvedAllComplete,
            hasTools: hasTools,
            completedToolCount: completedToolCount,
            deniedCount: deniedCount,
            hasDeniedToolCalls: hasDeniedToolCalls,
            hasPendingConfirmation: hasPendingConfirmation,
            hasStrippedToolCalls: hasStrippedToolCalls,
            totalToolCount: toolCalls.count,
            groupId: groupId,
            currentCall: currentCall,
            lastToolCall: toolCalls.last,
            lastIncompleteCall: lastIncompleteCall,
            skillExecuteLabel: skillExecuteLabel,
            uniqueToolNamesSorted: toolNameSet.sorted(),
            earliestStartedAt: earliestStart,
            latestCompletedAt: latestEnd,
            phase: phase,
            shouldAutoExpand: shouldAutoExpand
        )
    }

    // MARK: - Phase Resolution (private)

    /// Pure phase resolution matching the logic in AssistantProgressView.phase.
    private static func resolvePhase(
        hasTools: Bool,
        allComplete: Bool,
        hasDeniedToolCalls: Bool,
        isStreaming: Bool,
        hasText: Bool,
        isProcessing: Bool,
        streamingCodePreview: String?
    ) -> ProgressCardPhase {
        let hasIncompleteTools = hasTools && !allComplete

        // If confirmation was denied/timed out and tools are incomplete, those tools
        // will never finish — show the denied state instead of an indefinite spinner.
        if hasDeniedToolCalls && hasIncompleteTools {
            return .denied
        }

        // Streaming code preview active
        if isStreaming, let preview = streamingCodePreview, !preview.isEmpty {
            return .streamingCode
        }

        // At least one tool still running
        if hasTools && !allComplete {
            return .toolRunning
        }

        // All tools done, model composing response (daemon sent activity_state "thinking").
        if allComplete && isProcessing {
            return .processing
        }

        // All tools done but message still streaming with no text yet — more tools
        // may come. Show active "Thinking" state rather than premature "Completed N steps".
        if allComplete && isStreaming && !hasText {
            return .toolsCompleteThinking
        }

        // All done — either message finished or text is already visible while streaming.
        if allComplete && (!isStreaming || hasText) && !isProcessing {
            return .complete
        }

        // No tools, model working
        if !hasTools && (isStreaming || isProcessing) {
            return .processing
        }

        return .thinking
    }
}

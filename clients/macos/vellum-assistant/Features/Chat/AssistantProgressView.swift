import SwiftUI
import VellumAssistantShared

// MARK: - Progress Phase

/// Internal enum representing the current phase of assistant progress.
/// Derived from the combination of tool calls, streaming state, and text output.
private enum ProgressPhase: Equatable {
    case thinking
    case toolRunning
    case streamingCode
    case toolsCompleteThinking
    case processing
    case complete
    case error
    case denied
}

// MARK: - AssistantProgressView

/// Unified container that handles all tool progress states through a single component
/// that smoothly morphs between phases.
struct AssistantProgressView: View {
    let toolCalls: [ToolCallData]
    let isStreaming: Bool
    let hasText: Bool
    let isProcessing: Bool
    let processingStatusText: String?
    let streamingCodePreview: String?
    let streamingCodeToolName: String?
    let decidedConfirmation: ToolConfirmationData?
    var onRehydrate: (() -> Void)?

    @State private var isExpanded: Bool = false
    @State private var startDate: Date = Date()
    @State private var processingStartDate: Date?

    // MARK: - Derived State

    /// Whether the permission was denied or timed out, meaning incomplete tools were blocked.
    /// Mirrors `ChatBubbleToolStatusView.permissionWasDenied`.
    private var permissionWasDenied: Bool {
        decidedConfirmation?.state == .denied || decidedConfirmation?.state == .timedOut
    }

    private var phase: ProgressPhase {
        let allComplete = !toolCalls.isEmpty && toolCalls.allSatisfy(\.isComplete)
        let hasTools = !toolCalls.isEmpty
        let hasIncompleteTools = hasTools && !allComplete

        // Only enter error phase when ALL tools are done, at least one errored,
        // the model hasn't already produced a text response (i.e. it recovered),
        // and the model is no longer streaming (it may still recover with text or new tools).
        // While tools are still running, individual errors show as failed steps in the
        // expanded list without changing the overall phase.
        if allComplete && toolCalls.contains(where: { $0.isError }) && !hasText && !isStreaming {
            return .error
        }

        // If confirmation was denied/timed out and tools are incomplete, those tools
        // will never finish — show the denied state instead of an indefinite spinner.
        if permissionWasDenied && hasIncompleteTools {
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

        // All tools done but message still streaming with no text yet — more tools
        // may come. Show active "Thinking" state rather than premature "Completed N steps".
        // Once text appears, fall through to .complete (which shows warning icon if errors).
        if allComplete && isStreaming && !hasText {
            return .toolsCompleteThinking
        }

        // All tools done, model composing response
        if allComplete && isProcessing {
            return .processing
        }

        // All done — either message finished (!isStreaming && !isProcessing) or
        // text is already visible while streaming (user can see the response).
        // Uses warning icon + "Completed with N errors" if any tools failed.
        if allComplete && (!isStreaming || hasText) && !isProcessing {
            return .complete
        }

        // No tools, model working
        if !hasTools && (isStreaming || isProcessing) {
            return .processing
        }

        return .thinking
    }

    private var currentCall: ToolCallData? {
        toolCalls.first(where: { !$0.isComplete })
    }

    private var completedCount: Int {
        toolCalls.filter(\.isComplete).count
    }

    private var hasAnyErrors: Bool {
        toolCalls.contains(where: { $0.isError })
    }

    private var isAllAppTools: Bool {
        let appToolNames: Set<String> = ["app_create", "app_update", "app_file_edit", "app_file_write"]
        return !toolCalls.isEmpty && toolCalls.allSatisfy { appToolNames.contains($0.toolName) }
    }

    private var isActive: Bool {
        switch phase {
        case .thinking, .toolRunning, .streamingCode, .toolsCompleteThinking, .processing:
            return true
        case .complete, .error, .denied:
            return false
        }
    }

    private var headlineText: String {
        switch phase {
        case .thinking:
            return "Thinking..."
        case .toolRunning:
            if let current = currentCall {
                return ChatBubble.friendlyRunningLabel(
                    current.toolName,
                    inputSummary: current.inputSummary,
                    buildingStatus: current.buildingStatus
                )
            }
            return "Working"
        case .streamingCode:
            let rawName = streamingCodeToolName ?? ""
            let activeBuildingStatus = toolCalls.last(where: { !$0.isComplete })?.buildingStatus
            return ChatBubble.friendlyRunningLabel(rawName, buildingStatus: activeBuildingStatus)
        case .toolsCompleteThinking:
            return "Thinking"
        case .processing:
            return ChatBubble.friendlyProcessingLabel(processingStatusText)
        case .complete:
            if hasAnyErrors {
                let errorCount = toolCalls.filter(\.isError).count
                return "Completed with \(errorCount) error\(errorCount == 1 ? "" : "s")"
            }
            if isAllAppTools {
                return "Built your app"
            }
            return "Completed \(toolCalls.count) step\(toolCalls.count == 1 ? "" : "s")"
        case .error:
            return "Something went wrong"
        case .denied:
            let uniqueNames = Array(Set(toolCalls.map(\.toolName))).sorted()
            let primary = uniqueNames.first ?? "Tool"
            return ChatBubble.friendlyRunningLabel(primary) + " denied"
        }
    }

    private var hasChevron: Bool {
        !toolCalls.isEmpty
    }

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header row (always visible)
            headerRow

            // Expanded content
            if isExpanded {
                expandedContent
            }

            // Code preview (streaming code phase)
            if phase == .streamingCode, let code = streamingCodePreview {
                CodePreviewView(code: code)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.bottom, VSpacing.xs)
            }
        }
        .background(VColor.surface.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .onChange(of: phase) { _, newPhase in
            if newPhase == .processing {
                processingStartDate = Date()
            }
        }
        .onAppear {
            if phase == .processing && processingStartDate == nil {
                processingStartDate = Date()
            }
        }
    }

    // MARK: - Header Row

    private var headerRow: some View {
        Button(action: {
            guard hasChevron else { return }
            withAnimation(VAnimation.fast) {
                isExpanded.toggle()
            }
        }) {
            HStack(spacing: VSpacing.sm) {
                // Status icon
                statusIcon

                // Headline text with cross-fade
                headlineLabel

                Spacer()

                // Elapsed time (after 5 seconds, only when active)
                if isActive {
                    elapsedTimeLabel
                }

                // Permission chip (trailing, when decided)
                if let confirmation = decidedConfirmation, confirmation.state != .pending {
                    compactPermissionChip(confirmation)
                }

                // Chevron (only if tools exist)
                if hasChevron {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(VColor.textMuted)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
    }

    // MARK: - Status Icon

    @ViewBuilder
    private var statusIcon: some View {
        switch phase {
        case .complete:
            Image(systemName: hasAnyErrors ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .font(.system(size: 12))
                .foregroundColor(hasAnyErrors ? VColor.warning : VColor.success)
        case .error:
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 12))
                .foregroundColor(VColor.error)
        case .denied:
            if decidedConfirmation?.state == .timedOut {
                Image(systemName: "clock.fill")
                    .font(.system(size: 12))
                    .foregroundColor(VColor.textMuted)
            } else {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 12))
                    .foregroundColor(VColor.error)
            }
        default:
            Circle()
                .fill(VColor.accent)
                .frame(width: 8, height: 8)
                .modifier(AssistantProgressPulsingModifier())
        }
    }

    // MARK: - Headline Label

    private var headlineLabel: some View {
        Group {
            if phase == .processing {
                processingLabel
            } else {
                Text(headlineText)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .animation(.easeInOut(duration: 0.3), value: headlineText)
            }
        }
    }

    /// Progressive labels for the processing phase that cycle through at 8-second intervals.
    /// Uses `processingStartDate` (set when entering `.processing`) so label cycling starts
    /// from zero regardless of how long the view has been alive.
    private var processingLabel: some View {
        let initialLabel = ChatBubble.friendlyProcessingLabel(processingStatusText)
        let labels = [
            initialLabel,
            "Putting this together",
            "Finalizing your response",
        ]
        let anchor = processingStartDate ?? Date()

        return TimelineView(.periodic(from: .now, by: 0.4)) { context in
            let elapsed = max(0, context.date.timeIntervalSince(anchor))
            let labelIndex = max(0, min(Int(elapsed / 8), labels.count - 1))
            let dotPhase = max(0, Int(elapsed / 0.4) % 3)

            HStack(spacing: VSpacing.xs) {
                Text(labels[labelIndex])
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .animation(.easeInOut(duration: 0.3), value: labelIndex)

                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(VColor.textSecondary)
                        .frame(width: 5, height: 5)
                        .opacity(dotPhase == index ? 1.0 : 0.4)
                }
            }
        }
    }

    // MARK: - Elapsed Time

    private var elapsedTimeLabel: some View {
        TimelineView(.periodic(from: .now, by: 1.0)) { context in
            let elapsed = max(0, context.date.timeIntervalSince(startDate))
            if elapsed >= 5 {
                Text(RunningIndicator.formatElapsed(elapsed))
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }
        }
    }

    // MARK: - Expanded Content

    @ViewBuilder
    private var expandedContent: some View {
        switch phase {
        case .complete:
            // Full StepsSection for completed state
            StepsSection(toolCalls: toolCalls, onRehydrate: onRehydrate)
                .padding(.bottom, VSpacing.xs)
        default:
            // In-progress, error, or denied: show completed + running/blocked rows
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                ForEach(toolCalls) { toolCall in
                    if toolCall.isComplete {
                        completedToolRow(toolCall)
                    } else if phase == .denied {
                        // Permission was denied — show incomplete tools as blocked, not running
                        blockedToolRow(toolCall)
                    } else if toolCall.toolName == "claude_code" && !toolCall.claudeCodeSteps.isEmpty {
                        // Claude Code sub-steps
                        ClaudeCodeProgressView(steps: toolCall.claudeCodeSteps, isRunning: true)
                            .padding(.horizontal, VSpacing.sm)
                    } else {
                        runningToolRow(toolCall)
                    }
                }
            }
            .padding(.bottom, VSpacing.xs)
        }
    }

    // MARK: - Tool Rows

    private func completedToolRow(_ toolCall: ToolCallData) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: toolCall.isError ? "xmark.circle.fill" : "checkmark.circle.fill")
                    .font(.system(size: 10))
                    .foregroundColor(toolCall.isError ? VColor.error : VColor.success)
                    .frame(width: 14)

                Text(toolCall.actionDescription)
                    .font(VFont.captionMedium)
                    .foregroundColor(toolCall.isError ? VColor.error : VColor.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer()
            }

            // Reason subtitle
            if let reason = toolCall.reasonDescription, !reason.isEmpty {
                Text(reason)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.leading, 14 + VSpacing.sm)
            }
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xxs)
    }

    private func runningToolRow(_ toolCall: ToolCallData) -> some View {
        HStack(spacing: VSpacing.sm) {
            Circle()
                .fill(VColor.accent)
                .frame(width: 6, height: 6)
                .modifier(AssistantProgressPulsingModifier())
                .frame(width: 14)

            Text(ChatBubble.friendlyRunningLabel(
                toolCall.toolName,
                inputSummary: toolCall.inputSummary,
                buildingStatus: toolCall.buildingStatus
            ))
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textSecondary)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer()
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xxs)
    }

    private func blockedToolRow(_ toolCall: ToolCallData) -> some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 10))
                .foregroundColor(VColor.textMuted)
                .frame(width: 14)

            Text("Blocked — " + ChatBubble.friendlyRunningLabel(
                toolCall.toolName,
                inputSummary: toolCall.inputSummary,
                buildingStatus: toolCall.buildingStatus
            ))
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textMuted)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer()
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xxs)
    }

    // MARK: - Permission Chip

    private func compactPermissionChip(_ confirmation: ToolConfirmationData) -> some View {
        let isApproved = confirmation.state == .approved
        return HStack(spacing: VSpacing.xs) {
            Group {
                switch confirmation.state {
                case .approved:
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                case .denied:
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(VColor.error)
                case .timedOut:
                    Image(systemName: "clock.fill")
                        .foregroundColor(VColor.textMuted)
                default:
                    EmptyView()
                }
            }
            .font(.system(size: 12))

            Text(isApproved ? "\(confirmation.toolCategory) allowed" :
                 confirmation.state == .denied ? "\(confirmation.toolCategory) denied" : "Timed out")
                .font(VFont.caption)
                .foregroundColor(isApproved ? VColor.success : VColor.textSecondary)
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .background(
            Capsule().fill(isApproved ? VColor.success.opacity(0.1) : VColor.surface)
        )
        .overlay(
            Capsule().stroke(isApproved ? VColor.success.opacity(0.3) : VColor.surfaceBorder, lineWidth: 0.5)
        )
    }
}

// MARK: - Pulsing Modifier

private struct AssistantProgressPulsingModifier: ViewModifier {
    @State private var isPulsing = false

    func body(content: Content) -> some View {
        content
            .opacity(isPulsing ? 0.4 : 1.0)
            .animation(
                Animation.easeInOut(duration: 1.0).repeatForever(autoreverses: true),
                value: isPulsing
            )
            .onAppear { isPulsing = true }
    }
}

// MARK: - Previews

#if DEBUG

#Preview("Thinking") {
    ZStack {
        VColor.background.ignoresSafeArea()
        AssistantProgressView(
            toolCalls: [],
            isStreaming: true,
            hasText: false,
            isProcessing: true,
            processingStatusText: nil,
            streamingCodePreview: nil,
            streamingCodeToolName: nil,
            decidedConfirmation: nil
        )
        .frame(width: 520)
        .padding()
    }
}

#Preview("Tool Running") {
    ZStack {
        VColor.background.ignoresSafeArea()
        AssistantProgressView(
            toolCalls: [
                ToolCallData(toolName: "file_read", inputSummary: "/src/Config.swift", result: "import Foundation", isComplete: true, startedAt: Date().addingTimeInterval(-2), completedAt: Date().addingTimeInterval(-1)),
                ToolCallData(toolName: "bash", inputSummary: "npm test", result: "All tests passed", isComplete: true, startedAt: Date().addingTimeInterval(-1), completedAt: Date()),
                ToolCallData(toolName: "file_edit", inputSummary: "/src/Config.swift", isComplete: false, startedAt: Date()),
            ],
            isStreaming: true,
            hasText: false,
            isProcessing: false,
            processingStatusText: nil,
            streamingCodePreview: nil,
            streamingCodeToolName: nil,
            decidedConfirmation: nil
        )
        .frame(width: 520)
        .padding()
    }
}

#Preview("Tools Complete Thinking") {
    ZStack {
        VColor.background.ignoresSafeArea()
        AssistantProgressView(
            toolCalls: [
                ToolCallData(toolName: "file_read", inputSummary: "/src/main.ts", result: "content", isComplete: true, startedAt: Date().addingTimeInterval(-3), completedAt: Date().addingTimeInterval(-2)),
                ToolCallData(toolName: "bash", inputSummary: "npm test", result: "ok", isComplete: true, startedAt: Date().addingTimeInterval(-2), completedAt: Date().addingTimeInterval(-1)),
            ],
            isStreaming: true,
            hasText: false,
            isProcessing: false,
            processingStatusText: nil,
            streamingCodePreview: nil,
            streamingCodeToolName: nil,
            decidedConfirmation: nil
        )
        .frame(width: 520)
        .padding()
    }
}

#Preview("Processing") {
    ZStack {
        VColor.background.ignoresSafeArea()
        AssistantProgressView(
            toolCalls: [
                ToolCallData(toolName: "file_read", inputSummary: "/src/main.ts", result: "content", isComplete: true, startedAt: Date().addingTimeInterval(-3), completedAt: Date().addingTimeInterval(-2)),
                ToolCallData(toolName: "file_edit", inputSummary: "/src/main.ts", result: "edited", isComplete: true, startedAt: Date().addingTimeInterval(-2), completedAt: Date().addingTimeInterval(-1)),
            ],
            isStreaming: false,
            hasText: false,
            isProcessing: true,
            processingStatusText: "Processing results",
            streamingCodePreview: nil,
            streamingCodeToolName: nil,
            decidedConfirmation: nil
        )
        .frame(width: 520)
        .padding()
    }
}

#Preview("Complete") {
    ZStack {
        VColor.background.ignoresSafeArea()
        AssistantProgressView(
            toolCalls: [
                ToolCallData(toolName: "file_read", inputSummary: "/src/main.ts", result: "content", isComplete: true, startedAt: Date().addingTimeInterval(-3), completedAt: Date().addingTimeInterval(-2)),
                ToolCallData(toolName: "bash", inputSummary: "npm test", result: "All tests passed", isComplete: true, startedAt: Date().addingTimeInterval(-2), completedAt: Date().addingTimeInterval(-1)),
                ToolCallData(toolName: "file_edit", inputSummary: "/src/main.ts", result: "updated", isComplete: true, startedAt: Date().addingTimeInterval(-1), completedAt: Date()),
            ],
            isStreaming: false,
            hasText: true,
            isProcessing: false,
            processingStatusText: nil,
            streamingCodePreview: nil,
            streamingCodeToolName: nil,
            decidedConfirmation: nil
        )
        .frame(width: 520)
        .padding()
    }
}

#Preview("Error") {
    ZStack {
        VColor.background.ignoresSafeArea()
        AssistantProgressView(
            toolCalls: [
                ToolCallData(toolName: "file_read", inputSummary: "/src/main.ts", result: "content", isComplete: true, startedAt: Date().addingTimeInterval(-2), completedAt: Date().addingTimeInterval(-1)),
                ToolCallData(toolName: "bash", inputSummary: "rm -rf /important", result: "Permission denied", isError: true, isComplete: true, startedAt: Date().addingTimeInterval(-1), completedAt: Date()),
            ],
            isStreaming: false,
            hasText: false,
            isProcessing: false,
            processingStatusText: nil,
            streamingCodePreview: nil,
            streamingCodeToolName: nil,
            decidedConfirmation: nil
        )
        .frame(width: 520)
        .padding()
    }
}

#Preview("Streaming Code") {
    ZStack {
        VColor.background.ignoresSafeArea()
        AssistantProgressView(
            toolCalls: [
                ToolCallData(toolName: "file_read", inputSummary: "/src/App.tsx", result: "content", isComplete: true, startedAt: Date().addingTimeInterval(-2), completedAt: Date().addingTimeInterval(-1)),
                ToolCallData(toolName: "app_create", inputSummary: "my-app", isComplete: false, startedAt: Date()),
            ],
            isStreaming: true,
            hasText: false,
            isProcessing: false,
            processingStatusText: nil,
            streamingCodePreview: """
            import React from 'react';

            function App() {
                return (
                    <div className="app">
                        <h1>Hello World</h1>
                    </div>
                );
            }

            export default App;
            """,
            streamingCodeToolName: "app_create",
            decidedConfirmation: nil
        )
        .frame(width: 520)
        .padding()
    }
}

#endif

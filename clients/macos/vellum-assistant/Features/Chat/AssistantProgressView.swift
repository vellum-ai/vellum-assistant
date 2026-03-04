import SwiftUI
import VellumAssistantShared

/// Unified progress indicator for all assistant response lifecycle states.
/// Handles tool running, thinking, processing, complete, and error states
/// in a single container that smoothly morphs between phases.
struct AssistantProgressView: View {
    let toolCalls: [ToolCallData]
    let isRunning: Bool
    let isProcessing: Bool
    var statusText: String? = nil
    var onRehydrate: ((ToolCallData) -> Void)? = nil
    @Binding var isExpanded: Bool

    // MARK: - Derived state

    private var completedTools: [ToolCallData] {
        toolCalls.filter(\.isComplete)
    }

    private var currentTool: ToolCallData? {
        toolCalls.first(where: { !$0.isComplete })
    }

    private var hasIncompleteTools: Bool {
        toolCalls.contains(where: { !$0.isComplete })
    }

    private var hasError: Bool {
        completedTools.contains(where: { $0.isError })
    }

    private var completedCount: Int {
        completedTools.count
    }

    private var isAppBuild: Bool {
        let appToolNames: Set<String> = ["app_create", "app_update", "app_file_edit", "app_file_write"]
        return !toolCalls.isEmpty && toolCalls.allSatisfy { appToolNames.contains($0.toolName) }
    }

    /// The visual phase determines header icon, label, and detail content.
    private enum Phase: Equatable {
        case toolRunning
        case toolsCompleteThinking
        case processing
        case complete
        case error
    }

    private var phase: Phase {
        if hasError && !isRunning && !isProcessing {
            return .error
        }
        if isRunning && hasIncompleteTools {
            return .toolRunning
        }
        if isRunning && !hasIncompleteTools {
            return .toolsCompleteThinking
        }
        if isProcessing && !isRunning {
            return .processing
        }
        return .complete
    }

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerButton
            if isExpanded {
                detailSection
                    .padding(.bottom, VSpacing.xs)
            }
        }
        .background(VColor.surface.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    // MARK: - Header

    private var headerButton: some View {
        Button(action: {
            withAnimation(VAnimation.fast) {
                isExpanded.toggle()
            }
        }) {
            HStack(spacing: VSpacing.sm) {
                headerIcon
                headerLabel
                    .animation(VAnimation.standard, value: phase)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(VColor.textMuted)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
    }

    @ViewBuilder
    private var headerIcon: some View {
        switch phase {
        case .toolRunning, .toolsCompleteThinking, .processing:
            Circle()
                .fill(VColor.accent)
                .frame(width: 8, height: 8)
                .modifier(AssistantProgressPulsingModifier())
        case .complete:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 12))
                .foregroundColor(VColor.success)
        case .error:
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 12))
                .foregroundColor(VColor.error)
        }
    }

    @ViewBuilder
    private var headerLabel: some View {
        switch phase {
        case .toolRunning:
            if let current = currentTool {
                let label = current.reasonDescription
                    ?? ChatBubble.friendlyRunningLabel(
                        current.toolName,
                        inputSummary: current.inputSummary,
                        buildingStatus: current.buildingStatus
                    )
                Text(label)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            } else {
                Text("Working")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }

        case .toolsCompleteThinking:
            Text(statusText ?? "Thinking")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)

        case .processing:
            ProcessingLabel(statusText: statusText)

        case .complete:
            Text(isAppBuild ? "Built your app" : "Completed \(toolCalls.count) step\(toolCalls.count == 1 ? "" : "s")")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)

        case .error:
            Text("Something went wrong")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
        }
    }

    // MARK: - Detail section

    @ViewBuilder
    private var detailSection: some View {
        switch phase {
        case .toolRunning:
            toolRunningDetail
        case .toolsCompleteThinking:
            collapsedSummary
        case .processing:
            if !toolCalls.isEmpty {
                collapsedSummary
            }
        case .complete, .error:
            stepRows
        }
    }

    /// Shows completed steps with checkmarks and the current tool with a pulsing dot.
    /// For claude_code tools, embeds ClaudeCodeProgressView instead.
    private var toolRunningDetail: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            ForEach(toolCalls) { toolCall in
                if !toolCall.isComplete && toolCall.toolName == "claude_code" && !toolCall.claudeCodeSteps.isEmpty {
                    ClaudeCodeProgressView(steps: toolCall.claudeCodeSteps, isRunning: true)
                        .padding(.horizontal, VSpacing.sm)
                } else {
                    StepDetailRow(toolCall: toolCall, onRehydrate: onRehydrate)
                }
            }
        }
    }

    /// Compact summary for when tools are done but assistant is still working.
    private var collapsedSummary: some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 10))
                .foregroundColor(VColor.success)
                .frame(width: 14)

            Text("Completed \(completedCount) step\(completedCount == 1 ? "" : "s")")
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textSecondary)

            Spacer()
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xxs)
    }

    /// Expandable step rows for completed state.
    private var stepRows: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            ForEach(toolCalls) { toolCall in
                StepDetailRow(toolCall: toolCall, onRehydrate: onRehydrate)
            }
        }
    }
}

// MARK: - Step Detail Row

/// Individual step row with expandable detail section showing technical details,
/// screenshots, and output. Mirrors the expansion pattern from UsedToolsRow.
private struct StepDetailRow: View {
    let toolCall: ToolCallData
    var onRehydrate: ((ToolCallData) -> Void)?

    @State private var isDetailExpanded = false
    /// Cached formatted input to avoid re-running formatAllToolInput on every render.
    @State private var cachedInputFull: String?
    @Environment(\.displayScale) private var displayScale

    /// Lazily resolved full input text.
    private var resolvedInputFull: String {
        if let cached = cachedInputFull { return cached }
        if !toolCall.inputFull.isEmpty { return toolCall.inputFull }
        return ""
    }

    /// Whether the tool result or input appears truncated.
    private var isTruncated: Bool {
        (toolCall.result?.hasSuffix("[truncated]") ?? false)
            || toolCall.inputFull.hasSuffix("[truncated]")
    }

    /// Whether this completed tool has any detail content to show.
    private var hasDetails: Bool {
        guard toolCall.isComplete else { return false }
        return !toolCall.inputFull.isEmpty || toolCall.inputRawDict != nil
            || (toolCall.result != nil && !(toolCall.result?.isEmpty ?? true))
            || toolCall.cachedImage != nil
            || !toolCall.claudeCodeSteps.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Row header — tappable when details exist
            Button {
                guard hasDetails else { return }
                withAnimation(VAnimation.fast) { isDetailExpanded.toggle() }
            } label: {
                HStack(spacing: VSpacing.sm) {
                    // Status icon
                    if toolCall.isComplete {
                        Image(systemName: toolCall.isError ? "xmark.circle.fill" : "checkmark.circle.fill")
                            .font(.system(size: 10))
                            .foregroundColor(toolCall.isError ? VColor.error : VColor.success)
                            .frame(width: 14)
                    } else {
                        Circle()
                            .fill(VColor.accent)
                            .frame(width: 6, height: 6)
                            .modifier(AssistantProgressPulsingModifier())
                            .frame(width: 14)
                    }

                    // Action description + reason
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        if toolCall.isComplete {
                            Text(toolCall.actionDescription)
                                .font(VFont.captionMedium)
                                .foregroundColor(toolCall.isError ? VColor.error : VColor.textSecondary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        } else {
                            Text(ChatBubble.friendlyRunningLabel(
                                toolCall.toolName,
                                inputSummary: toolCall.inputSummary,
                                buildingStatus: toolCall.buildingStatus
                            ))
                            .font(VFont.captionMedium)
                            .foregroundColor(VColor.textSecondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        }

                        if let reason = toolCall.reasonDescription, !reason.isEmpty {
                            Text(reason)
                                .font(VFont.small)
                                .foregroundColor(VColor.textMuted)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                    }

                    Spacer()

                    // Duration + chevron
                    HStack(spacing: VSpacing.xs) {
                        if let start = toolCall.startedAt, let end = toolCall.completedAt, toolCall.isComplete {
                            Text(formatDuration(end.timeIntervalSince(start)))
                                .font(VFont.small)
                                .foregroundColor(VColor.textMuted)
                        }

                        if hasDetails {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundColor(VColor.textMuted)
                                .rotationEffect(.degrees(isDetailExpanded ? 90 : 0))
                        }
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xxs)

            // Expanded detail section
            if isDetailExpanded {
                stepDetailContent
                    .transition(.opacity.combined(with: .move(edge: .top)))
                    .onAppear {
                        // Cache formatted input on first expand
                        if cachedInputFull == nil {
                            if !toolCall.inputFull.isEmpty {
                                cachedInputFull = toolCall.inputFull
                            } else if let dict = toolCall.inputRawDict {
                                cachedInputFull = ToolCallData.formatAllToolInput(dict)
                            }
                        }
                        // Trigger rehydration for truncated content
                        if toolCall.inputFull.isEmpty || isTruncated {
                            onRehydrate?(toolCall)
                        }
                    }
            }
        }
        .animation(VAnimation.fast, value: isDetailExpanded)
        .onChange(of: isDetailExpanded) { _, newValue in
            // Pre-populate cache before expanded body evaluates
            if newValue, cachedInputFull == nil {
                if let dict = toolCall.inputRawDict {
                    cachedInputFull = ToolCallData.formatAllToolInput(dict)
                } else if !toolCall.inputFull.isEmpty {
                    cachedInputFull = toolCall.inputFull
                }
            }
        }
        .onChange(of: toolCall.inputFull) {
            cachedInputFull = nil
        }
    }

    // MARK: - Detail content

    @ViewBuilder
    private var stepDetailContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Technical details
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack {
                    Text("Technical details")
                        .font(VFont.small)
                        .foregroundColor(VColor.textMuted)
                        .textCase(.uppercase)
                    if isTruncated {
                        Text("truncated")
                            .font(VFont.caption)
                            .foregroundColor(VColor.warning)
                            .padding(.horizontal, VSpacing.xs)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.xs)
                                    .fill(VColor.warning.opacity(0.12))
                            )
                    }
                }

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(toolCall.friendlyName)
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.textSecondary)
                    if !resolvedInputFull.isEmpty {
                        ScrollView {
                            Text(resolvedInputFull)
                                .font(VFont.monoSmall)
                                .foregroundColor(VColor.textSecondary)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: 120)
                    }
                }
            }
            .padding(.horizontal, VSpacing.sm)

            // Claude Code sub-steps
            if !toolCall.claudeCodeSteps.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Sub-steps")
                        .font(VFont.small)
                        .foregroundColor(VColor.textMuted)
                        .textCase(.uppercase)

                    ClaudeCodeProgressView(
                        steps: toolCall.claudeCodeSteps,
                        isRunning: false
                    )
                }
                .padding(.horizontal, VSpacing.sm)
            }

            // Screenshot preview
            if let img = toolCall.cachedImage,
               let cgImage = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                Image(decorative: cgImage, scale: displayScale)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    .padding(.horizontal, VSpacing.sm)
            } else if let img = toolCall.cachedImage {
                Image(nsImage: img)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    .padding(.horizontal, VSpacing.sm)
            }

            // Output / result
            if let result = toolCall.result, !result.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Output")
                        .font(VFont.small)
                        .foregroundColor(VColor.textMuted)
                        .textCase(.uppercase)

                    ZStack(alignment: .topTrailing) {
                        ScrollView {
                            Text(result)
                                .font(VFont.monoSmall)
                                .foregroundColor(toolCall.isError ? VColor.error : VColor.textSecondary)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: 120)
                        .padding(VSpacing.sm)
                        .background(VColor.background.opacity(0.6))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))

                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(result, forType: .string)
                        } label: {
                            Image(systemName: "doc.on.doc")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundColor(VColor.textMuted)
                                .frame(width: 24, height: 24)
                                .background(VColor.backgroundSubtle)
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.xs))
                        }
                        .buttonStyle(.plain)
                        .padding(VSpacing.xs)
                        .accessibilityLabel("Copy output")
                    }
                }
                .padding(.horizontal, VSpacing.sm)
            }
        }
        .padding(.top, VSpacing.xs)
        .padding(.bottom, VSpacing.sm)
    }

    // MARK: - Duration formatting

    private func formatDuration(_ seconds: TimeInterval) -> String {
        if seconds < 60 {
            return String(format: "%.1fs", seconds)
        }
        let mins = Int(seconds) / 60
        let secs = Int(seconds) % 60
        return "\(mins)m \(secs)s"
    }
}

// MARK: - Processing Label (progressive cycling)

/// Cycles through progressive labels for the processing state using TimelineView.
private struct ProcessingLabel: View {
    let statusText: String?

    @State private var startDate = Date()

    private var initialLabel: String {
        ChatBubble.friendlyProcessingLabel(statusText)
    }

    private func displayLabel(elapsed: TimeInterval) -> String {
        if elapsed >= 16 { return "Finalizing your response" }
        if elapsed >= 8 { return "Putting this together" }
        return initialLabel
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1.0)) { context in
            let elapsed = context.date.timeIntervalSince(startDate)
            Text(displayLabel(elapsed: elapsed))
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .animation(VAnimation.standard, value: Int(elapsed / 8))
        }
        .onAppear { startDate = Date() }
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

private struct RunningPreview: View {
    @State private var isExpanded = true

    private func makeRunning(name: String, summary: String, reason: String?) -> ToolCallData {
        var tc = ToolCallData(
            toolName: name,
            inputSummary: summary,
            isComplete: false,
            startedAt: Date()
        )
        tc.reasonDescription = reason
        return tc
    }

    private func makeCompleted(name: String, summary: String, reason: String?, offsetStart: Double, offsetEnd: Double) -> ToolCallData {
        var tc = ToolCallData(
            toolName: name,
            inputSummary: summary,
            result: "OK",
            isComplete: true,
            startedAt: Date().addingTimeInterval(offsetStart),
            completedAt: Date().addingTimeInterval(offsetEnd)
        )
        tc.reasonDescription = reason
        return tc
    }

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            AssistantProgressView(
                toolCalls: [
                    makeCompleted(name: "file_read", summary: "/src/Config.swift", reason: "Checking existing implementation", offsetStart: -1.2, offsetEnd: -0.8),
                    makeCompleted(name: "bash", summary: "swift build", reason: "Verifying the project compiles", offsetStart: -0.7, offsetEnd: -0.2),
                    makeRunning(name: "file_edit", summary: "/src/Config.swift", reason: "Adding error handling to the config loader"),
                ],
                isRunning: true,
                isProcessing: false,
                isExpanded: $isExpanded
            )
            .frame(width: 480)
            .padding()
        }
    }
}

private struct CompletePreview: View {
    @State private var isExpanded = true

    private func makeToolCall(name: String, summary: String, reason: String?, offsetStart: Double, offsetEnd: Double) -> ToolCallData {
        var tc = ToolCallData(
            toolName: name,
            inputSummary: summary,
            result: "OK",
            isComplete: true,
            startedAt: Date().addingTimeInterval(offsetStart),
            completedAt: Date().addingTimeInterval(offsetEnd)
        )
        tc.reasonDescription = reason
        return tc
    }

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            AssistantProgressView(
                toolCalls: [
                    makeToolCall(name: "file_read", summary: "/src/main.swift", reason: "Checking existing implementation", offsetStart: -3.0, offsetEnd: -2.5),
                    makeToolCall(name: "bash", summary: "swift test", reason: "Verifying tests pass", offsetStart: -2.4, offsetEnd: -1.0),
                    makeToolCall(name: "file_edit", summary: "/src/main.swift", reason: "Adding error handling", offsetStart: -0.9, offsetEnd: -0.1),
                ],
                isRunning: false,
                isProcessing: false,
                isExpanded: $isExpanded
            )
            .frame(width: 480)
            .padding()
        }
    }
}

private struct ErrorPreview: View {
    @State private var isExpanded = true

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            AssistantProgressView(
                toolCalls: [
                    ToolCallData(
                        toolName: "file_read",
                        inputSummary: "/src/Config.swift",
                        result: "import Foundation",
                        isComplete: true,
                        startedAt: Date().addingTimeInterval(-2.0),
                        completedAt: Date().addingTimeInterval(-1.5)
                    ),
                    ToolCallData(
                        toolName: "bash",
                        inputSummary: "swift build",
                        result: "Build complete!",
                        isComplete: true,
                        startedAt: Date().addingTimeInterval(-1.4),
                        completedAt: Date().addingTimeInterval(-0.8)
                    ),
                    ToolCallData(
                        toolName: "bash",
                        inputSummary: "rm -rf /important",
                        result: "Permission denied",
                        isError: true,
                        isComplete: true,
                        startedAt: Date().addingTimeInterval(-0.7),
                        completedAt: Date().addingTimeInterval(-0.3)
                    ),
                ],
                isRunning: false,
                isProcessing: false,
                isExpanded: $isExpanded
            )
            .frame(width: 480)
            .padding()
        }
    }
}

private struct ProcessingPreview: View {
    @State private var isExpanded = true

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            AssistantProgressView(
                toolCalls: [
                    ToolCallData(
                        toolName: "web_search",
                        inputSummary: "SwiftUI best practices",
                        result: "Found 10 results",
                        isComplete: true,
                        startedAt: Date().addingTimeInterval(-4.0),
                        completedAt: Date().addingTimeInterval(-3.0)
                    ),
                    ToolCallData(
                        toolName: "web_fetch",
                        inputSummary: "https://developer.apple.com",
                        result: "Page content",
                        isComplete: true,
                        startedAt: Date().addingTimeInterval(-2.9),
                        completedAt: Date().addingTimeInterval(-1.5)
                    ),
                    ToolCallData(
                        toolName: "file_write",
                        inputSummary: "/src/summary.md",
                        result: "Written",
                        isComplete: true,
                        startedAt: Date().addingTimeInterval(-1.4),
                        completedAt: Date().addingTimeInterval(-0.5)
                    ),
                ],
                isRunning: false,
                isProcessing: true,
                isExpanded: $isExpanded
            )
            .frame(width: 480)
            .padding()
        }
    }
}

#Preview("Running") { RunningPreview() }
#Preview("Complete") { CompletePreview() }
#Preview("Error") { ErrorPreview() }
#Preview("Processing") { ProcessingPreview() }

#endif

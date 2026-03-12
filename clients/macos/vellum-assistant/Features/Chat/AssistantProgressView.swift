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
    let decidedConfirmations: [ToolConfirmationData]
    var onRehydrate: (() -> Void)?

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.suppressAutoScroll) private var suppressAutoScroll
    @State private var isExpanded: Bool = false
    @State private var startDate: Date = Date()
    @State private var processingStartDate: Date?
    @State private var isOverflowPopoverShown: Bool = false
    @State private var suppressNextExpand: Bool = false

    // MARK: - Derived State

    private var phase: ProgressPhase {
        let allComplete = !toolCalls.isEmpty && toolCalls.allSatisfy(\.isComplete)
        let hasTools = !toolCalls.isEmpty
        let hasIncompleteTools = hasTools && !allComplete

        // If confirmation was denied/timed out and tools are incomplete, those tools
        // will never finish — show the denied state instead of an indefinite spinner.
        if hasDeniedTools && hasIncompleteTools {
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
        // Once text appears, fall through to .complete (which shows warning icon if denied).
        if allComplete && isStreaming && !hasText {
            return .toolsCompleteThinking
        }

        // All tools done, model composing response
        if allComplete && isProcessing {
            return .processing
        }

        // All done — either message finished (!isStreaming && !isProcessing) or
        // text is already visible while streaming (user can see the response).
        // Uses warning icon + "Completed with N blocked permission(s)" if any tools were denied.
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

    /// Single source of truth for denied state — used for both `.denied` phase gating
    /// and `.complete` warning styling/copy. Checks live confirmations and persisted per-tool data.
    private var hasDeniedTools: Bool {
        decidedConfirmations.contains { $0.state == .denied || $0.state == .timedOut }
            || toolCalls.contains { $0.confirmationDecision == .denied || $0.confirmationDecision == .timedOut }
    }

    /// Count of denied/timed-out tool calls. Counted exclusively from `toolCalls` (not
    /// `decidedConfirmations`) because only tool calls carry a `toolUseId` for dedup.
    private var deniedCount: Int {
        toolCalls.filter { $0.confirmationDecision == .denied || $0.confirmationDecision == .timedOut }.count
    }

    private var isActive: Bool {
        switch phase {
        case .thinking, .toolRunning, .streamingCode, .toolsCompleteThinking, .processing:
            return true
        case .complete, .denied:
            return false
        }
    }

    private var headlineText: String {
        switch phase {
        case .thinking:
            return "Thinking..."
        case .toolRunning:
            if let current = currentCall {
                if let reason = current.reasonDescription, !reason.isEmpty {
                    return reason
                }
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
            if let lastTool = toolCalls.last {
                if let reason = lastTool.reasonDescription, !reason.isEmpty {
                    return reason
                }
                return ChatBubble.friendlyRunningLabel(
                    lastTool.toolName,
                    inputSummary: lastTool.inputSummary,
                    buildingStatus: lastTool.buildingStatus
                )
            }
            return "Working"
        case .processing:
            return ChatBubble.friendlyProcessingLabel(processingStatusText)
        case .complete:
            if hasDeniedTools {
                if deniedCount > 0 {
                    return "Completed with \(deniedCount) blocked permission\(deniedCount == 1 ? "" : "s")"
                }
                return "Completed with blocked permissions"
            }
            return "Completed \(toolCalls.count) step\(toolCalls.count == 1 ? "" : "s")"
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
                    .padding(.bottom, VSpacing.xs)
            }

            // Code preview (streaming code phase)
            if phase == .streamingCode, let code = streamingCodePreview {
                CodePreviewView(code: code)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.bottom, VSpacing.xs)
            }
        }
        .background(colorScheme == .light ? Moss._50 : VColor.surface.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .onChange(of: phase) { _, newPhase in
            if newPhase == .processing {
                processingStartDate = Date()
                startDate = Date()
            }
        }
        .onChange(of: isExpanded) { _, expanded in
            if expanded, onRehydrate != nil {
                // Trigger rehydrate when expanding if any complete tool call
                // has been stripped (all detail fields cleared by stripHeavyContent).
                let hasStrippedToolCall = toolCalls.contains { tc in
                    tc.isComplete
                        && tc.inputFull.isEmpty
                        && tc.result == nil
                        && tc.inputRawDict == nil
                        && tc.cachedImage == nil
                }
                if hasStrippedToolCall {
                    onRehydrate?()
                }
            }
        }
        .onAppear {
            if phase == .processing && processingStartDate == nil {
                processingStartDate = Date()
            }
            // Seed startDate from persisted timestamps so the header timer
            // shows correct elapsed time after history restore.
            if let earliest = toolCalls.compactMap(\.startedAt).min() {
                startDate = earliest
            }
        }
    }

    // MARK: - Header Row

    private var headerRow: some View {
        Button(action: {
            if suppressNextExpand {
                suppressNextExpand = false
                return
            }
            guard hasChevron else { return }
            suppressAutoScroll?()
            withAnimation(VAnimation.fast) {
                isExpanded.toggle()
            }
        }) {
            HStack(spacing: VSpacing.sm) {
                // Status icon
                statusIcon

                // Headline text with cross-fade
                headlineLabel

                // Inline permission chips (collapsed only, max 2 + overflow)
                if !isExpanded {
                    inlinePermissionChips
                }

                Spacer()

                // Elapsed time: live counter when active, final duration when complete
                if isActive {
                    elapsedTimeLabel
                } else if !toolCalls.isEmpty {
                    completedDurationLabel
                }

                // Chevron (only if tools exist)
                if hasChevron {
                    VIconView(isExpanded ? .chevronUp : .chevronDown, size: 9)
                        .foregroundColor(VColor.textMuted)
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
            VIconView(hasDeniedTools ? .triangleAlert : .circleCheck, size: 12)
                .foregroundColor(hasDeniedTools ? VColor.warning : VColor.iconAccent)
        case .denied:
            if decidedConfirmations.contains(where: { $0.state == .timedOut }) {
                VIconView(.clock, size: 12)
                    .foregroundColor(VColor.textMuted)
            } else {
                VIconView(.circleAlert, size: 12)
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
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
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
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
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

    // MARK: - Completed Duration

    @ViewBuilder
    private var completedDurationLabel: some View {
        let earliest = toolCalls.compactMap(\.startedAt).min()
        let latest = toolCalls.compactMap(\.completedAt).max()
        if let start = earliest, let end = latest {
            let seconds = end.timeIntervalSince(start)
            Text(seconds < 60
                ? String(format: "%.1fs", seconds)
                : "\(Int(seconds) / 60)m \(Int(seconds) % 60)s")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
    }

    // MARK: - Expanded Content

    @ViewBuilder
    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(toolCalls) { toolCall in
                if !toolCall.isComplete && toolCall.toolName == "claude_code"
                    && !toolCall.claudeCodeSteps.isEmpty {
                    ClaudeCodeProgressView(steps: toolCall.claudeCodeSteps, isRunning: true)
                        .padding(.horizontal, VSpacing.lg)
                } else {
                    StepDetailRow(toolCall: toolCall, phase: phase, onRehydrate: onRehydrate)
                }
            }
        }
    }

    // MARK: - Inline Permission Chips (Collapsed Header)

    @ViewBuilder
    private var inlinePermissionChips: some View {
        let resolved = decidedConfirmations.filter { $0.state != .pending }
        if !resolved.isEmpty {
            // Vertical divider
            Divider()
                .frame(height: 16)

            // Show up to 2 chips inline
            let visible = Array(resolved.prefix(2))
            let overflow = resolved.count - visible.count

            ForEach(Array(visible.enumerated()), id: \.offset) { _, confirmation in
                CompactPermissionChip(state: confirmation.state, label: confirmation.toolCategory)
            }

            // +N overflow badge with popover
            if overflow > 0 {
                Button(action: {
                    suppressNextExpand = true
                    isOverflowPopoverShown.toggle()
                }) {
                    Text("+\(overflow)")
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.textSecondary)
                        .padding(.horizontal, VSpacing.xs)
                        .padding(.vertical, VSpacing.xxs)
                        .background(
                            Capsule().fill(VColor.backgroundSubtle)
                        )
                        .overlay(
                            Capsule().stroke(VColor.surfaceBorder, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(overflow) more permissions")
                .popover(isPresented: $isOverflowPopoverShown, arrowEdge: .bottom) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        ForEach(Array(resolved.dropFirst(2).enumerated()), id: \.offset) { _, confirmation in
                            CompactPermissionChip(state: confirmation.state, label: confirmation.toolCategory)
                        }
                    }
                    .padding(VSpacing.sm)
                }
            }
        }
    }

}

// MARK: - Step Detail Row

/// Unified row for tool call steps — handles completed, running, and blocked states.
/// Completed rows are expandable to show technical details, screenshots, and output.
private struct StepDetailRow: View {
    let toolCall: ToolCallData
    let phase: ProgressPhase
    var onRehydrate: (() -> Void)?

    @State private var isDetailExpanded = false
    @State private var isHovered = false
    /// Cached formatted input — computed once on first expand.
    @State private var cachedInputFull: String?
    @Environment(\.displayScale) private var displayScale
    @Environment(\.suppressAutoScroll) private var suppressAutoScroll

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

    /// Whether this tool has detail content to show (running or completed).
    private var hasDetails: Bool {
        return !toolCall.inputFull.isEmpty || toolCall.inputRawDict != nil
            || !toolCall.partialOutput.isEmpty
            || (toolCall.result != nil && !(toolCall.result?.isEmpty ?? true))
            || !toolCall.claudeCodeSteps.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Row header
            Button {
                guard hasDetails else { return }
                suppressAutoScroll?()
                withAnimation(VAnimation.fast) { isDetailExpanded.toggle() }
            } label: {
                HStack(spacing: VSpacing.sm) {
                    // Status icon
                    if toolCall.isComplete {
                        VIconView(toolCall.isError ? .circleAlert : .circleCheck, size: 12)
                            .foregroundColor(toolCall.isError ? VColor.error : VColor.iconAccent)
                            .frame(width: 16)
                    } else if phase == .denied {
                        VIconView(.circleAlert, size: 12)
                            .foregroundColor(VColor.textMuted)
                            .frame(width: 16)
                    } else {
                        Circle()
                            .fill(VColor.accent)
                            .frame(width: 6, height: 6)
                            .modifier(AssistantProgressPulsingModifier())
                            .frame(width: 16)
                    }

                    // Title (reason-first, falling back to action/running label)
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        if toolCall.isComplete {
                            Text({
                                if let reason = toolCall.reasonDescription, !reason.isEmpty {
                                    return reason
                                }
                                return toolCall.actionDescription
                            }())
                                .font(VFont.caption)
                                .foregroundColor(toolCall.isError ? VColor.error : VColor.textPrimary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        } else if phase == .denied {
                            Text({
                                if let reason = toolCall.reasonDescription, !reason.isEmpty {
                                    return "Blocked — " + reason
                                }
                                return "Blocked — " + ChatBubble.friendlyRunningLabel(
                                    toolCall.toolName,
                                    inputSummary: toolCall.inputSummary,
                                    buildingStatus: toolCall.buildingStatus
                                )
                            }())
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        } else {
                            Text({
                                if let reason = toolCall.reasonDescription, !reason.isEmpty {
                                    return reason
                                }
                                return ChatBubble.friendlyRunningLabel(
                                    toolCall.toolName,
                                    inputSummary: toolCall.inputSummary,
                                    buildingStatus: toolCall.buildingStatus
                                )
                            }())
                            .font(VFont.caption)
                            .foregroundColor(VColor.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        }
                    }

                    Spacer()

                    // Permission badge + duration + chevron (completed only)
                    HStack(spacing: VSpacing.xs) {
                        if let decision = toolCall.confirmationDecision {
                            CompactPermissionChip(
                                state: decision,
                                label: toolCall.confirmationLabel ?? toolCall.friendlyName
                            )
                            .padding(.trailing, VSpacing.xs)
                        }

                        if let start = toolCall.startedAt, let end = toolCall.completedAt, toolCall.isComplete {
                            Text(formatDuration(end.timeIntervalSince(start)))
                                .font(VFont.small)
                                .foregroundColor(VColor.textMuted)
                        }

                        if hasDetails {
                            VIconView(.chevronRight, size: 9)
                                .foregroundColor(VColor.textMuted)
                                .rotationEffect(.degrees(isDetailExpanded ? 90 : 0))
                        }
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.leading, VSpacing.sm)
            .padding(.trailing, VSpacing.xs)
            .padding(.vertical, VSpacing.xs)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isHovered && hasDetails ? VColor.surfaceBorder.opacity(0.5) : .clear)
            )
            .padding(.leading, VSpacing.sm)
            .padding(.trailing, VSpacing.xs)
            .onHover { isHovered = $0 }

            // Expanded detail section (completed only)
            if isDetailExpanded {
                stepDetailContent
                    .transition(.opacity)
                    .onAppear {
                        if cachedInputFull == nil {
                            if !toolCall.inputFull.isEmpty {
                                cachedInputFull = toolCall.inputFull
                            } else if let dict = toolCall.inputRawDict {
                                cachedInputFull = ToolCallData.formatAllToolInput(dict)
                            }
                        }
                        if isTruncated {
                            onRehydrate?()
                        }
                    }
            }
        }
        .animation(VAnimation.fast, value: isDetailExpanded)
        .onChange(of: isDetailExpanded) { _, newValue in
            if newValue, cachedInputFull == nil {
                if !toolCall.inputFull.isEmpty {
                    cachedInputFull = toolCall.inputFull
                } else if let dict = toolCall.inputRawDict {
                    cachedInputFull = ToolCallData.formatAllToolInput(dict)
                }
            }
        }
        .onChange(of: toolCall.inputFull) {
            cachedInputFull = nil
        }
    }

    // MARK: - Detail Content

    @ViewBuilder
    private var stepDetailContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Divider().padding(.horizontal, VSpacing.lg)

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
                    if let reason = toolCall.reasonDescription, !reason.isEmpty {
                        Text(toolCall.actionDescription)
                            .font(VFont.captionMedium)
                            .foregroundColor(VColor.textSecondary)
                    }
                    Text(toolCall.friendlyName)
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.textSecondary)
                    if !resolvedInputFull.isEmpty {
                        Text(resolvedInputFull)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.textSecondary)
                            .textSelection(.enabled)
                    }
                }
            }
            .padding(.horizontal, VSpacing.lg)

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
                .padding(.horizontal, VSpacing.lg)
            }

            // Live output: shown while tool is running, and also as fallback
            // when the tool completed without a final result (cancel/error).
            if !toolCall.partialOutput.isEmpty && (!toolCall.isComplete || (toolCall.result ?? "").isEmpty) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(toolCall.isComplete ? "Output" : "Live output")
                        .font(VFont.small)
                        .foregroundColor(VColor.textMuted)
                        .textCase(.uppercase)

                    ZStack(alignment: .topTrailing) {
                        ScrollView {
                            Text(toolCall.partialOutput)
                                .font(VFont.monoSmall)
                                .foregroundColor(VColor.textSecondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .textSelection(.enabled)
                        }
                        .defaultScrollAnchor(.bottom)
                        .frame(maxHeight: 200)
                        .padding(VSpacing.sm)
                        .background(VColor.background.opacity(0.6))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.sm)
                                .stroke(VColor.surfaceBorder, lineWidth: 0.5)
                        )

                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(toolCall.partialOutput, forType: .string)
                        } label: {
                            VIconView(.copy, size: 10)
                                .foregroundColor(VColor.textMuted)
                                .frame(width: 24, height: 24)
                                .background(VColor.backgroundSubtle)
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.xs))
                        }
                        .buttonStyle(.plain)
                        .padding(VSpacing.xs)
                        .accessibilityLabel("Copy live output")
                    }
                }
                .padding(.horizontal, VSpacing.lg)
            }

            // Tool call images are rendered inline below the progress view
            // by inlineToolCallImages(from:), so they are not duplicated here.

            // Output with diff coloring + copy button
            if let result = toolCall.result, !result.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Output")
                        .font(VFont.small)
                        .foregroundColor(VColor.textMuted)
                        .textCase(.uppercase)

                    ZStack(alignment: .topTrailing) {
                        ScrollView {
                            Text(coloredOutput(result, isError: toolCall.isError))
                                .font(VFont.monoSmall)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .textSelection(.enabled)
                        }
                        .frame(maxHeight: 200)
                        .padding(VSpacing.sm)
                        .background(VColor.background.opacity(0.6))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.sm)
                                .stroke(VColor.surfaceBorder, lineWidth: 0.5)
                        )

                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(result, forType: .string)
                        } label: {
                            VIconView(.copy, size: 10)
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
                .padding(.horizontal, VSpacing.lg)
            }
        }
        .padding(.bottom, VSpacing.sm)
    }

    // MARK: - Helpers

    private func coloredOutput(_ result: String, isError: Bool) -> AttributedString {
        let lines = result.components(separatedBy: "\n")
        let isDiff = result.contains("@@") && result.contains("---") && result.contains("+++")
        var attributed = AttributedString()
        for (index, line) in lines.enumerated() {
            var part = AttributedString(line)
            let color: Color
            if isError {
                color = VColor.error
            } else if !isDiff {
                color = VColor.textSecondary
            } else if line.hasPrefix("+") {
                color = Emerald._400
            } else if line.hasPrefix("-") {
                color = Danger._400
            } else if line.hasPrefix("@@") {
                color = VColor.textMuted
            } else {
                color = VColor.textSecondary
            }
            part.foregroundColor = color
            attributed.append(part)
            if index < lines.count - 1 {
                attributed.append(AttributedString("\n"))
            }
        }
        return attributed
    }

    private func formatDuration(_ seconds: TimeInterval) -> String {
        seconds < 60
            ? String(format: "%.1fs", seconds)
            : "\(Int(seconds) / 60)m \(Int(seconds) % 60)s"
    }

}

// MARK: - Compact Permission Chip

/// Shared permission chip used in both the collapsed header (inline chips)
/// and expanded step detail rows (per-tool-call badge).
private struct CompactPermissionChip: View {
    let state: ToolConfirmationState
    let label: String

    private var chipColor: Color {
        switch state {
        case .approved: VColor.iconAccent
        case .denied: VColor.error
        default: VColor.textMuted
        }
    }

    var body: some View {
        HStack(spacing: VSpacing.xxs) {
            Group {
                switch state {
                case .approved:
                    VIconView(.circleCheck, size: 10)
                        .foregroundColor(chipColor)
                case .denied:
                    VIconView(.circleAlert, size: 10)
                        .foregroundColor(chipColor)
                case .timedOut:
                    VIconView(.clock, size: 10)
                        .foregroundColor(chipColor)
                default:
                    EmptyView()
                }
            }

            Text(state == .approved || state == .denied ? label : "Timed Out")
                .font(VFont.small)
                .foregroundColor(chipColor)
        }
        .padding(.horizontal, VSpacing.xs)
        .padding(.vertical, VSpacing.xxs)
        .background(
            Capsule().fill(Color.clear)
        )
        .overlay(
            Capsule().stroke(chipColor.opacity(0.3), lineWidth: 1)
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
            decidedConfirmations: []
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
            decidedConfirmations: []
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
            decidedConfirmations: []
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
            decidedConfirmations: []
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
            decidedConfirmations: []
        )
        .frame(width: 520)
        .padding()
    }
}

#Preview("Complete with Errors (no denied)") {
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
            decidedConfirmations: []
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
            decidedConfirmations: []
        )
        .frame(width: 520)
        .padding()
    }
}

#endif

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

    @State private var isExpanded: Bool = false
    @State private var startDate: Date = Date()
    @State private var processingStartDate: Date?

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

    private var completedCount: Int {
        toolCalls.filter(\.isComplete).count
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
            return "Thinking"
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

            // Permission chips below header (when not expanded)
            if !isExpanded {
                permissionChips
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.bottom, VSpacing.sm)
            }

            // Expanded content
            if isExpanded {
                expandedContent

                // Permission chips at bottom of expanded list
                permissionChips
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.top, VSpacing.sm)
                    .padding(.bottom, VSpacing.sm)
            }

            // Code preview (streaming code phase)
            if phase == .streamingCode, let code = streamingCodePreview {
                CodePreviewView(code: code)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.bottom, VSpacing.sm)
            }
        }
        .padding(.bottom, isExpanded ? VSpacing.sm : 0)
        .background(VColor.surface.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .onChange(of: phase) { _, newPhase in
            if newPhase == .processing {
                processingStartDate = Date()
                startDate = Date()
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

                // Elapsed time: live counter when active, final duration when complete
                if isActive {
                    elapsedTimeLabel
                } else if !toolCalls.isEmpty {
                    completedDurationLabel
                }

                // Chevron (only if tools exist)
                if hasChevron {
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(VColor.textMuted)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Status Icon

    @ViewBuilder
    private var statusIcon: some View {
        switch phase {
        case .complete:
            statusIconTile(
                systemName: hasDeniedTools ? "exclamationmark.triangle.fill" : "checkmark.circle.fill",
                iconColor: hasDeniedTools ? VColor.warning : VColor.iconAccent,
                tileColor: hasDeniedTools ? Amber._200 : Forest._200
            )
        case .denied:
            if decidedConfirmations.contains(where: { $0.state == .timedOut }) {
                statusIconTile(
                    systemName: "clock.fill",
                    iconColor: VColor.textMuted,
                    tileColor: Moss._200
                )
            } else {
                statusIconTile(
                    systemName: "exclamationmark.circle.fill",
                    iconColor: VColor.error,
                    tileColor: Danger._200
                )
            }
        default:
            Circle()
                .fill(VColor.accent)
                .frame(width: 8, height: 8)
                .modifier(AssistantProgressPulsingModifier())
        }
    }

    private func statusIconTile(systemName: String, iconColor: Color, tileColor: Color) -> some View {
        Image(systemName: systemName)
            .font(.system(size: 14))
            .foregroundColor(iconColor)
            .padding(VSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(tileColor)
            )
    }

    // MARK: - Headline Label

    private var headlineLabel: some View {
        Group {
            if phase == .processing {
                processingLabel
            } else {
                Text(headlineText)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
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
                    .font(VFont.bodyMedium)
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

    // MARK: - Permission Chips

    @ViewBuilder
    private var permissionChips: some View {
        let resolved = decidedConfirmations.filter { $0.state != .pending }
        if !resolved.isEmpty {
            HStack(spacing: VSpacing.xs) {
                ForEach(Array(resolved.enumerated()), id: \.offset) { _, confirmation in
                    compactPermissionChip(confirmation)
                }
            }
        }
    }

    private func compactPermissionChip(_ confirmation: ToolConfirmationData) -> some View {
        let isApproved = confirmation.state == .approved
        let isDenied = confirmation.state == .denied
        let chipColor: Color = isApproved ? VColor.iconAccent : isDenied ? VColor.error : VColor.textMuted

        return HStack(spacing: VSpacing.xs) {
            Group {
                switch confirmation.state {
                case .approved:
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(chipColor)
                case .denied:
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundColor(chipColor)
                case .timedOut:
                    Image(systemName: "clock.fill")
                        .foregroundColor(chipColor)
                default:
                    EmptyView()
                }
            }
            .font(.system(size: 12))

            Text(isApproved ? "\(confirmation.toolCategory) Allowed" :
                 isDenied ? "\(confirmation.toolCategory) Denied" : "Timed Out")
                .font(VFont.captionMedium)
                .foregroundColor(chipColor)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(
            Capsule().fill(Color.clear)
        )
        .overlay(
            Capsule().stroke(chipColor.opacity(0.3), lineWidth: 1)
        )
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
    @State private var isImageHovered = false
    /// Cached formatted input — computed once on first expand.
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

    /// Whether this completed tool has detail content to show.
    private var hasDetails: Bool {
        guard toolCall.isComplete else { return false }
        return !toolCall.inputFull.isEmpty || toolCall.inputRawDict != nil
            || (toolCall.result != nil && !(toolCall.result?.isEmpty ?? true))
            || toolCall.cachedImage != nil
            || !toolCall.claudeCodeSteps.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Row header
            Button {
                guard hasDetails else { return }
                withAnimation(VAnimation.fast) { isDetailExpanded.toggle() }
            } label: {
                HStack(spacing: VSpacing.sm) {
                    // Status icon
                    if toolCall.isComplete {
                        Image(systemName: toolCall.isError ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                            .font(.system(size: 14))
                            .foregroundColor(toolCall.isError ? VColor.error : VColor.iconAccent)
                            .frame(width: 16)
                    } else if phase == .denied {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.system(size: 14))
                            .foregroundColor(VColor.textMuted)
                            .frame(width: 16)
                    } else {
                        Circle()
                            .fill(VColor.accent)
                            .frame(width: 6, height: 6)
                            .modifier(AssistantProgressPulsingModifier())
                            .frame(width: 16)
                    }

                    // Title + reason
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        if toolCall.isComplete {
                            Text(toolCall.actionDescription)
                                .font(VFont.bodyMedium)
                                .foregroundColor(toolCall.isError ? VColor.error : VColor.textPrimary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        } else if phase == .denied {
                            Text("Blocked — " + ChatBubble.friendlyRunningLabel(
                                toolCall.toolName,
                                inputSummary: toolCall.inputSummary,
                                buildingStatus: toolCall.buildingStatus
                            ))
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.textMuted)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        } else {
                            Text(ChatBubble.friendlyRunningLabel(
                                toolCall.toolName,
                                inputSummary: toolCall.inputSummary,
                                buildingStatus: toolCall.buildingStatus
                            ))
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        }

                        // Reason subtitle — only for completed tools
                        if let reason = toolCall.reasonDescription, !reason.isEmpty, toolCall.isComplete {
                            Text(reason)
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                    }

                    Spacer()

                    // Duration + chevron (completed only)
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
            .padding(.vertical, VSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isHovered && hasDetails ? Moss._100 : .clear)
            )
            .padding(.horizontal, VSpacing.sm)
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

            // Screenshot — Retina rendering + double-click → Preview.app
            if let img = toolCall.cachedImage,
               let cgImage = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                Image(decorative: cgImage, scale: displayScale)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    .padding(.horizontal, VSpacing.lg)
                    .onTapGesture(count: 2) { openImageInPreview(img) }
                    .onHover { hovering in
                        if hovering { NSCursor.pointingHand.push() }
                        else { NSCursor.pop() }
                        isImageHovered = hovering
                    }
                    .onDisappear { if isImageHovered { NSCursor.pop(); isImageHovered = false } }
            } else if let img = toolCall.cachedImage {
                Image(nsImage: img)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    .padding(.horizontal, VSpacing.lg)
                    .onTapGesture(count: 2) { openImageInPreview(img) }
                    .onHover { hovering in
                        if hovering { NSCursor.pointingHand.push() }
                        else { NSCursor.pop() }
                        isImageHovered = hovering
                    }
                    .onDisappear { if isImageHovered { NSCursor.pop(); isImageHovered = false } }
            }

            // Output with diff coloring + copy button
            if let result = toolCall.result, !result.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Output")
                        .font(VFont.small)
                        .foregroundColor(VColor.textMuted)
                        .textCase(.uppercase)

                    ZStack(alignment: .topTrailing) {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 0) {
                                ForEach(Array(result.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                                    Text(line)
                                        .font(VFont.monoSmall)
                                        .foregroundColor(diffLineColor(line, result: result, isError: toolCall.isError))
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
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
                .padding(.horizontal, VSpacing.lg)
            }
        }
        .padding(.bottom, VSpacing.sm)
    }

    // MARK: - Helpers

    private func openImageInPreview(_ image: NSImage) {
        let path = toolCall.inputRawValue
        if !path.isEmpty && FileManager.default.fileExists(atPath: path) {
            openInPreview(URL(fileURLWithPath: path))
            return
        }
        guard let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else { return }
        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("vellum-preview-\(UUID().uuidString).png")
        do {
            try png.write(to: tempURL)
            openInPreview(tempURL)
        } catch {}
    }

    private func openInPreview(_ url: URL) {
        let previewURL = URL(fileURLWithPath: "/System/Applications/Preview.app")
        NSWorkspace.shared.open(
            [url],
            withApplicationAt: previewURL,
            configuration: NSWorkspace.OpenConfiguration()
        )
    }

    private func diffLineColor(_ line: String, result: String, isError: Bool) -> Color {
        if isError { return VColor.error }
        let isDiff = result.contains("@@") && result.contains("---") && result.contains("+++")
        guard isDiff else { return VColor.textSecondary }
        if line.hasPrefix("+") { return Emerald._400 }
        if line.hasPrefix("-") { return Danger._400 }
        if line.hasPrefix("@@") { return VColor.textMuted }
        return VColor.textSecondary
    }

    private func formatDuration(_ seconds: TimeInterval) -> String {
        seconds < 60
            ? String(format: "%.1fs", seconds)
            : "\(Int(seconds) / 60)m \(Int(seconds) % 60)s"
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

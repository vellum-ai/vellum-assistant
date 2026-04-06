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

// MARK: - Derived Progress State

/// Caches all O(n) derived properties from `toolCalls` in a single pass.
/// Recomputed only when `toolCalls` or `decidedConfirmations` change,
/// avoiding redundant filtering/searching/sorting on every body render.
private struct DerivedProgressState: Equatable {
    var allComplete: Bool = true
    var hasTools: Bool = false
    var completedToolCount: Int = 0
    var deniedCount: Int = 0
    var hasDeniedToolCalls: Bool = false
    var hasPendingConfirmation: Bool = false
    var groupId: String = "no-tools"
    var currentCall: ToolCallData? = nil
    var lastToolCall: ToolCallData? = nil
    var lastIncompleteCall: ToolCallData? = nil
    var skillExecuteLabel: String = "Using a skill"
    var uniqueToolNamesSorted: [String] = []
    var earliestStartedAt: Date? = nil
    var latestCompletedAt: Date? = nil
    var totalToolCount: Int = 0

    /// Computes all derived values in a single O(n) pass over toolCalls.
    static func compute(
        toolCalls: [ToolCallData],
        decidedConfirmations: [ToolConfirmationData]
    ) -> DerivedProgressState {
        var state = DerivedProgressState()
        state.totalToolCount = toolCalls.count
        state.hasTools = !toolCalls.isEmpty

        var allComplete = true
        var foundFirstIncomplete = false
        var lastSkillLoad: ToolCallData? = nil
        var toolNameSet = Set<String>()
        var earliestStart: Date? = nil
        var latestEnd: Date? = nil

        for toolCall in toolCalls {
            // Track completion
            if toolCall.isComplete {
                state.completedToolCount += 1
            } else {
                allComplete = false
                if !foundFirstIncomplete {
                    state.currentCall = toolCall
                    foundFirstIncomplete = true
                }
                state.lastIncompleteCall = toolCall
            }

            // Track denied/timed-out
            if toolCall.confirmationDecision == .denied || toolCall.confirmationDecision == .timedOut {
                state.deniedCount += 1
                state.hasDeniedToolCalls = true
            }

            // Track pending confirmations
            if toolCall.pendingConfirmation != nil {
                state.hasPendingConfirmation = true
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

        state.allComplete = !toolCalls.isEmpty && allComplete
        state.lastToolCall = toolCalls.last
        state.groupId = toolCalls.first?.id.uuidString ?? "no-tools"
        state.earliestStartedAt = earliestStart
        state.latestCompletedAt = latestEnd
        state.uniqueToolNamesSorted = toolNameSet.sorted()

        // Derive skill execute label
        if let skillLoad = lastSkillLoad,
           let skillId = skillLoad.inputRawDict?["skill"]?.value as? String,
           !skillId.isEmpty {
            let display = skillId
                .replacingOccurrences(of: "-", with: " ")
                .replacingOccurrences(of: "_", with: " ")
            state.skillExecuteLabel = "Using my \(display) skill"
        }

        // Check decidedConfirmations for denied state
        if !state.hasDeniedToolCalls {
            for confirmation in decidedConfirmations {
                if confirmation.state == .denied || confirmation.state == .timedOut {
                    state.hasDeniedToolCalls = true
                    break
                }
            }
        }

        return state
    }
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

    // Confirmation action callbacks (threaded from MessageListView)
    var onConfirmationAllow: ((String) -> Void)? = nil   // requestId
    var onConfirmationDeny: ((String) -> Void)? = nil     // requestId
    var onAlwaysAllow: ((String, String, String, String) -> Void)? = nil
    var onTemporaryAllow: ((String, String) -> Void)? = nil
    var activeConfirmationRequestId: String? = nil  // For keyboard focus

    /// Step detail expansion state lifted from StepDetailRow to survive
    /// the trailing→interleaved rendering path switch in ChatBubble.
    @Binding var expandedStepIds: Set<UUID>
    /// Card-level expansion overrides lifted from this view's @State to
    /// survive view recreation. Keyed by first tool call UUID in the group.
    @Binding var cardExpansionOverrides: [UUID: Bool]

    @Environment(\.suppressAutoScroll) private var suppressAutoScroll
    @State private var isExpanded: Bool
    @State private var startDate: Date
    @State private var processingStartDate: Date?
    @State private var isOverflowPopoverShown: Bool = false
    @State private var suppressNextExpand: Bool = false
    @State private var derived: DerivedProgressState

    // MARK: - Init

    init(
        toolCalls: [ToolCallData],
        isStreaming: Bool,
        hasText: Bool,
        isProcessing: Bool,
        processingStatusText: String? = nil,
        streamingCodePreview: String? = nil,
        streamingCodeToolName: String? = nil,
        decidedConfirmations: [ToolConfirmationData],
        onRehydrate: (() -> Void)? = nil,
        onConfirmationAllow: ((String) -> Void)? = nil,
        onConfirmationDeny: ((String) -> Void)? = nil,
        onAlwaysAllow: ((String, String, String, String) -> Void)? = nil,
        onTemporaryAllow: ((String, String) -> Void)? = nil,
        activeConfirmationRequestId: String? = nil,
        expandedStepIds: Binding<Set<UUID>>,
        cardExpansionOverrides: Binding<[UUID: Bool]>
    ) {
        self.toolCalls = toolCalls
        self.isStreaming = isStreaming
        self.hasText = hasText
        self.isProcessing = isProcessing
        self.processingStatusText = processingStatusText
        self.streamingCodePreview = streamingCodePreview
        self.streamingCodeToolName = streamingCodeToolName
        self.decidedConfirmations = decidedConfirmations
        self.onRehydrate = onRehydrate
        self.onConfirmationAllow = onConfirmationAllow
        self.onConfirmationDeny = onConfirmationDeny
        self.onAlwaysAllow = onAlwaysAllow
        self.onTemporaryAllow = onTemporaryAllow
        self.activeConfirmationRequestId = activeConfirmationRequestId
        self._expandedStepIds = expandedStepIds
        self._cardExpansionOverrides = cardExpansionOverrides
        _derived = State(initialValue: DerivedProgressState.compute(
            toolCalls: toolCalls,
            decidedConfirmations: decidedConfirmations
        ))
        let derived = _derived.wrappedValue
        let isComplete = derived.hasTools && derived.allComplete
        let isDenied = derived.hasDeniedToolCalls && derived.hasTools && !derived.allComplete
        let expandFlag = MacOSClientFeatureFlagManager.shared.isEnabled("expand-completed-steps")
        let shouldAutoExpand = (isComplete || isDenied) && expandFlag
        let initialStartDate = derived.earliestStartedAt ?? Date()
        let initialProcessingStartDate: Date? = if isProcessing && (derived.allComplete || !derived.hasTools) {
            Date()
        } else {
            nil
        }
        // Seed from user override if one exists, otherwise use auto-expand logic.
        if let key = toolCalls.first?.id,
           let override = cardExpansionOverrides.wrappedValue[key] {
            _isExpanded = State(initialValue: override)
        } else {
            _isExpanded = State(initialValue: shouldAutoExpand || derived.hasPendingConfirmation)
        }
        _startDate = State(initialValue: initialStartDate)
        _processingStartDate = State(initialValue: initialProcessingStartDate)
    }

    /// Stable key for this progress card in `cardExpansionOverrides`.
    private var cardKey: UUID? { toolCalls.first?.id }

    // MARK: - Derived State (reads from cached DerivedProgressState)

    private var phase: ProgressPhase {
        let hasIncompleteTools = derived.hasTools && !derived.allComplete

        // If confirmation was denied/timed out and tools are incomplete, those tools
        // will never finish — show the denied state instead of an indefinite spinner.
        if derived.hasDeniedToolCalls && hasIncompleteTools {
            return .denied
        }

        // Streaming code preview active
        if isStreaming, let preview = streamingCodePreview, !preview.isEmpty {
            return .streamingCode
        }

        // At least one tool still running
        if derived.hasTools && !derived.allComplete {
            return .toolRunning
        }

        // All tools done, model composing response (daemon sent activity_state "thinking").
        // Check this before toolsCompleteThinking so the "Processing results" label
        // is shown instead of the stale last-tool label during extended thinking gaps.
        if derived.allComplete && isProcessing {
            return .processing
        }

        // All tools done but message still streaming with no text yet — more tools
        // may come. Show active "Thinking" state rather than premature "Completed N steps".
        // Once text appears, fall through to .complete (which shows warning icon if denied).
        if derived.allComplete && isStreaming && !hasText {
            return .toolsCompleteThinking
        }

        // All done — either message finished (!isStreaming && !isProcessing) or
        // text is already visible while streaming (user can see the response).
        // Uses warning icon + "Completed with N blocked permission(s)" if any tools were denied.
        if derived.allComplete && (!isStreaming || hasText) && !isProcessing {
            return .complete
        }

        // No tools, model working
        if !derived.hasTools && (isStreaming || isProcessing) {
            return .processing
        }

        return .thinking
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
            if let current = derived.currentCall {
                if let reason = current.reasonDescription, !reason.isEmpty {
                    return reason
                }
                if current.toolName == "skill_execute" {
                    return derived.skillExecuteLabel
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
            let activeBuildingStatus = derived.lastIncompleteCall?.buildingStatus
            return ChatBubble.friendlyRunningLabel(rawName, buildingStatus: activeBuildingStatus)
        case .toolsCompleteThinking:
            if let lastTool = derived.lastToolCall {
                if let reason = lastTool.reasonDescription, !reason.isEmpty {
                    return reason
                }
                if lastTool.toolName == "skill_execute" {
                    return derived.skillExecuteLabel
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
            if derived.hasDeniedToolCalls {
                if derived.deniedCount > 0 {
                    return "Completed with \(derived.deniedCount) blocked permission\(derived.deniedCount == 1 ? "" : "s")"
                }
                return "Completed with blocked permissions"
            }
            return "Completed \(derived.totalToolCount) step\(derived.totalToolCount == 1 ? "" : "s")"
        case .denied:
            let primary = derived.uniqueToolNamesSorted.first ?? "Tool"
            return ChatBubble.friendlyRunningLabel(primary) + " denied"
        }
    }

    private var hasChevron: Bool {
        derived.hasTools
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
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .onChange(of: toolCalls) { _, newToolCalls in
            handleToolCallsChange(newToolCalls)
        }
        .onChange(of: decidedConfirmations) { _, newConfirmations in
            handleConfirmationsChange(newConfirmations)
        }
        .onChange(of: phase) { _, newPhase in
            handlePhaseChange(newPhase)
        }
        .onChange(of: isExpanded) { _, expanded in
            handleExpansionChange(expanded)
        }
        .onChange(of: derived.hasPendingConfirmation) { _, pending in
            handlePendingConfirmationChange(pending)
        }
        .onAppear {
            handleOnAppear()
        }
    }

    // MARK: - Change Handlers (extracted to reduce body type-check complexity)

    private func handleToolCallsChange(_ newToolCalls: [ToolCallData]) {
        derived = DerivedProgressState.compute(toolCalls: newToolCalls, decidedConfirmations: decidedConfirmations)
        syncStartDateFromDerivedIfNeeded()
    }

    private func handleConfirmationsChange(_ newConfirmations: [ToolConfirmationData]) {
        derived = DerivedProgressState.compute(toolCalls: toolCalls, decidedConfirmations: newConfirmations)
        syncStartDateFromDerivedIfNeeded()
    }

    private func handlePhaseChange(_ newPhase: ProgressPhase) {
        let expandFlag = MacOSClientFeatureFlagManager.shared.isEnabled("expand-completed-steps")
        ChatDiagnosticsStore.shared.record(ChatDiagnosticEvent(
            kind: .progressCardTransition,
            reason: "phase_change:\(newPhase) group=\(derived.groupId) phase=\(newPhase) expand_flag=\(expandFlag) completed=\(derived.completedToolCount)/\(derived.totalToolCount) denied=\(derived.deniedCount) pending_confirm=\(derived.hasPendingConfirmation) rehydrate=\(onRehydrate != nil)",
            toolCallCount: derived.totalToolCount
        ))
        // Auto-expand when a step group completes, if the flag is enabled.
        // Skip if the user has explicitly set a preference for this card.
        let hasUserCardPreference = cardKey != nil && cardExpansionOverrides[cardKey!] != nil
        let shouldAutoExpandOnPhaseChange = (newPhase == .complete || newPhase == .denied)
            && !hasUserCardPreference
            && MacOSClientFeatureFlagManager.shared.isEnabled("expand-completed-steps")
        deferProgressStateMutation {
            if newPhase == .processing, phase == .processing {
                processingStartDate = Date()
                if derived.earliestStartedAt == nil {
                    startDate = Date()
                }
            }
            if shouldAutoExpandOnPhaseChange, !isExpanded {
                ChatDiagnosticsStore.shared.record(ChatDiagnosticEvent(
                    kind: .progressCardTransition,
                    reason: "auto_expand:completed_steps_flag group=\(derived.groupId) phase=\(newPhase) expand_flag=true completed=\(derived.completedToolCount)/\(derived.totalToolCount) pending_confirm=\(derived.hasPendingConfirmation) rehydrate=\(onRehydrate != nil)",
                    toolCallCount: derived.totalToolCount
                ))
                withAnimation(VAnimation.fast) {
                    isExpanded = true
                }
            }
        }
    }

    private func handleExpansionChange(_ expanded: Bool) {
        if expanded, onRehydrate != nil {
            // Trigger rehydrate when expanding if any complete tool call
            // has been stripped (all detail fields cleared by stripHeavyContent).
            if hasStrippedToolCalls {
                onRehydrate?()
            }
        }
    }

    private func handlePendingConfirmationChange(_ pending: Bool) {
        // Pending confirmations always force-expand — user must be able to
        // see and interact with the approval UI.
        guard pending else { return }
        deferProgressStateMutation {
            guard derived.hasPendingConfirmation, !isExpanded else { return }
            ChatDiagnosticsStore.shared.record(ChatDiagnosticEvent(
                kind: .progressCardTransition,
                reason: "auto_expand:pending_confirmation",
                toolCallCount: derived.totalToolCount
            ))
            withAnimation(VAnimation.fast) {
                isExpanded = true
            }
        }
    }

    private func handleOnAppear() {
        let wasExpandedOnEntry = isExpanded
        let shouldAutoExpandPendingOnAppear = derived.hasPendingConfirmation && !isExpanded
        let shouldRehydrateOnAppear = wasExpandedOnEntry && onRehydrate != nil && hasStrippedToolCalls

        deferProgressStateMutation {
            syncStartDateFromDerivedIfNeeded()
            if phase == .processing && processingStartDate == nil {
                processingStartDate = Date()
                if derived.earliestStartedAt == nil {
                    startDate = Date()
                }
            }

            if shouldAutoExpandPendingOnAppear && derived.hasPendingConfirmation && !isExpanded {
                ChatDiagnosticsStore.shared.record(ChatDiagnosticEvent(
                    kind: .progressCardTransition,
                    reason: "auto_expand:pending_confirmation_on_appear",
                    toolCallCount: derived.totalToolCount
                ))
                withAnimation(VAnimation.fast) {
                    isExpanded = true
                }
            }

            if shouldRehydrateOnAppear {
                onRehydrate?()
            }
        }
    }

    /// Whether any completed tool call has been stripped of its heavy content.
    private var hasStrippedToolCalls: Bool {
        toolCalls.contains { tc in
            tc.isComplete
                && tc.inputFull.isEmpty
                && tc.result == nil
                && tc.inputRawDict == nil
                && tc.cachedImages.isEmpty
        }
    }

    private func deferProgressStateMutation(_ update: @escaping @MainActor () -> Void) {
        Task { @MainActor in
            update()
        }
    }

    @MainActor
    private func syncStartDateFromDerivedIfNeeded() {
        if let earliest = derived.earliestStartedAt, startDate != earliest {
            startDate = earliest
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
            // Prevent collapsing while a confirmation is pending — the inline
            // bubble is the only visible approval UI when the standalone is suppressed.
            if isExpanded && derived.hasPendingConfirmation { return }
            ChatDiagnosticsStore.shared.record(ChatDiagnosticEvent(
                kind: .progressCardTransition,
                reason: "manual_toggle:\(isExpanded ? "collapse" : "expand")",
                toolCallCount: derived.totalToolCount
            ))
            suppressAutoScroll?()
            withAnimation(VAnimation.fast) {
                isExpanded.toggle()
            }
            if let key = cardKey { cardExpansionOverrides[key] = isExpanded }
        }) {
            // Let SwiftUI choose the compact variant instead of toggling local
            // state from a geometry callback, which can create layout feedback
            // loops while the progress card is updating mid-send.
            ViewThatFits(in: .horizontal) {
                headerRowContent(showInlinePermissionChips: !isExpanded)
                headerRowContent(showInlinePermissionChips: false)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .environment(\.isEnabled, true)
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func headerRowContent(showInlinePermissionChips: Bool) -> some View {
        HStack(spacing: VSpacing.sm) {
            // Status icon
            statusIcon

            // Headline text with cross-fade
            headlineLabel

            if showInlinePermissionChips {
                inlinePermissionChips
            }

            Spacer()

            // Elapsed time: live counter when active, final duration when complete
            if isActive {
                elapsedTimeLabel
            } else if derived.hasTools {
                completedDurationLabel
            }

            // Chevron (only if tools exist)
            if hasChevron {
                VIconView(isExpanded ? .chevronUp : .chevronDown, size: 9)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    // MARK: - Status Icon

    @ViewBuilder
    private var statusIcon: some View {
        switch phase {
        case .complete:
            VIconView(derived.hasDeniedToolCalls ? .triangleAlert : .circleCheck, size: 12)
                .foregroundStyle(derived.hasDeniedToolCalls ? VColor.systemNegativeHover : VColor.primaryBase)
        case .denied:
            if decidedConfirmations.contains(where: { $0.state == .timedOut }) {
                VIconView(.clock, size: 12)
                    .foregroundStyle(VColor.contentTertiary)
            } else {
                VIconView(.circleAlert, size: 12)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
        default:
            Circle()
                .fill(VColor.primaryBase)
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
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
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
        // Pin the label when compacting — don't cycle to generic labels.
        let pinLabel = processingStatusText?.lowercased().contains("compacting") == true
        let labels: [String] = pinLabel ? [initialLabel] : [
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
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                    .animation(.easeInOut(duration: 0.3), value: labelIndex)

                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(VColor.contentSecondary)
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
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    // MARK: - Completed Duration

    @ViewBuilder
    private var completedDurationLabel: some View {
        if let start = derived.earliestStartedAt, let end = derived.latestCompletedAt {
            let seconds = end.timeIntervalSince(start)
            Text(seconds < 60
                ? String(format: "%.1fs", seconds)
                : "\(Int(seconds) / 60)m \(Int(seconds) % 60)s")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
    }

    // MARK: - Expanded Content

    /// Derives a `Binding<Bool>` for a single step's expansion state from the
    /// shared `expandedStepIds` set. The binding is scoped to one tool call ID
    /// so StepDetailRow can use it as a drop-in replacement for `@State`.
    private func isStepExpanded(_ id: UUID) -> Binding<Bool> {
        Binding(
            get: { expandedStepIds.contains(id) },
            set: { newValue in
                if newValue { expandedStepIds.insert(id) }
                else { expandedStepIds.remove(id) }
            }
        )
    }

    @ViewBuilder
    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(toolCalls) { toolCall in
                StepDetailRow(
                    toolCall: toolCall,
                    phase: phase,
                    isDetailExpanded: isStepExpanded(toolCall.id),
                    skillLabel: toolCall.toolName == "skill_execute" ? derived.skillExecuteLabel : nil,
                    onRehydrate: onRehydrate
                )

                // Inline confirmation bubble for tool calls awaiting approval
                if let confirmation = toolCall.pendingConfirmation {
                    ToolConfirmationBubble(
                        confirmation: confirmation,
                        isKeyboardActive: confirmation.requestId == activeConfirmationRequestId,
                        onAllow: { onConfirmationAllow?(confirmation.requestId) },
                        onDeny: { onConfirmationDeny?(confirmation.requestId) },
                        onAlwaysAllow: onAlwaysAllow ?? { _, _, _, _ in },
                        onTemporaryAllow: onTemporaryAllow
                    )
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)
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
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .padding(.horizontal, VSpacing.xs)
                        .padding(.vertical, VSpacing.xxs)
                        .background(
                            Capsule().fill(VColor.surfaceBase)
                        )
                        .overlay(
                            Capsule().stroke(VColor.borderBase, lineWidth: 1)
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
    /// Expansion state lifted to ChatBubble so it survives the
    /// trailing→interleaved rendering path switch mid-stream.
    @Binding var isDetailExpanded: Bool
    /// Human-friendly label for skill_execute rows (e.g. "Using my frontend design skill").
    var skillLabel: String?
    var onRehydrate: (() -> Void)?
    @State private var isHovered = false
    @Environment(\.displayScale) private var displayScale
    @Environment(\.suppressAutoScroll) private var suppressAutoScroll

    /// Lazily resolved full input text.
    private var resolvedInputFull: String {
        if !toolCall.inputFull.isEmpty { return toolCall.inputFull }
        if let dict = toolCall.inputRawDict { return ToolCallData.formatAllToolInput(dict) }
        return ""
    }

    /// Whether this tool has detail content to show (running or completed).
    private var hasDetails: Bool {
        return !toolCall.inputFull.isEmpty || toolCall.inputRawDict != nil
            || !toolCall.partialOutput.isEmpty
            || (toolCall.result != nil && !(toolCall.result?.isEmpty ?? true))
    }

    /// Resolves the display title for this step row based on its current state.
    /// Extracted from the view body to avoid Swift type-checker timeout on complex
    /// inline closures inside `Text()`.
    private var stepTitle: String {
        if let reason = toolCall.reasonDescription, !reason.isEmpty {
            return phase == .denied ? "Blocked — " + reason : reason
        }
        if let label = skillLabel {
            return phase == .denied ? "Blocked — " + label : label
        }
        if toolCall.isComplete {
            return toolCall.actionDescription
        }
        let friendlyLabel = ChatBubble.friendlyRunningLabel(
            toolCall.toolName,
            inputSummary: toolCall.inputSummary,
            buildingStatus: toolCall.buildingStatus
        )
        return phase == .denied ? "Blocked — " + friendlyLabel : friendlyLabel
    }

    private var stepTitleColor: Color {
        if toolCall.isComplete {
            return toolCall.isError ? VColor.systemNegativeStrong : VColor.contentDefault
        }
        if phase == .denied {
            return VColor.contentTertiary
        }
        return VColor.contentDefault
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
                            .foregroundStyle(toolCall.isError ? VColor.systemNegativeStrong : VColor.primaryBase)
                            .frame(width: 16)
                    } else if phase == .denied {
                        VIconView(.circleAlert, size: 12)
                            .foregroundStyle(VColor.contentTertiary)
                            .frame(width: 16)
                    } else {
                        Circle()
                            .fill(VColor.primaryBase)
                            .frame(width: 6, height: 6)
                            .modifier(AssistantProgressPulsingModifier())
                            .frame(width: 16)
                    }

                    // Title (reason-first, then skillLabel for skill_execute, then fallback)
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text(stepTitle)
                            .font(VFont.labelDefault)
                            .foregroundStyle(stepTitleColor)
                            .lineLimit(1)
                            .truncationMode(.tail)
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
                                .font(VFont.labelSmall)
                                .foregroundStyle(VColor.contentTertiary)
                        }

                        if hasDetails {
                            VIconView(.chevronRight, size: 9)
                                .foregroundStyle(VColor.contentTertiary)
                                .rotationEffect(.degrees(isDetailExpanded ? 90 : 0))
                        }
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .environment(\.isEnabled, true)
            .padding(.leading, VSpacing.sm)
            .padding(.trailing, VSpacing.xs)
            .padding(.vertical, VSpacing.xs)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isHovered && hasDetails ? VColor.borderBase.opacity(0.5) : .clear)
            )
            .padding(.leading, VSpacing.sm)
            .padding(.trailing, VSpacing.xs)
            .onHover { isHovered = $0 }

            // Expanded detail section (completed only)
            if isDetailExpanded {
                stepDetailContent
                    .transition(.opacity)
            }
        }
        .animation(VAnimation.fast, value: isDetailExpanded)
        .onChange(of: isDetailExpanded) { _, newValue in
            if newValue {
                Task { @MainActor in
                    onRehydrate?()
                }
            }
        }
    }

    // MARK: - Detail Content

    @ViewBuilder
    private var stepDetailContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Divider().padding(.horizontal, VSpacing.lg)

            // Technical details
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Technical details")
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
                    .textCase(.uppercase)

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    if let reason = toolCall.reasonDescription, !reason.isEmpty {
                        Text(toolCall.actionDescription)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)
                    }
                    Text(toolCall.friendlyName)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    if !resolvedInputFull.isEmpty {
                        Text(resolvedInputFull)
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.horizontal, VSpacing.lg)

            // Live output: shown while tool is running, and also as fallback
            // when the tool completed without a final result (cancel/error).
            if !toolCall.partialOutput.isEmpty && (!toolCall.isComplete || (toolCall.result ?? "").isEmpty) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(toolCall.isComplete ? "Output" : "Live output")
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.contentTertiary)
                        .textCase(.uppercase)

                    outputBlock(
                        text: toolCall.partialOutput,
                        attributedText: nil,
                        copyText: toolCall.partialOutput,
                        copyLabel: "Copy live output"
                    )
                }
                .padding(.horizontal, VSpacing.lg)
            }

            // Tool call images are rendered inline below the progress view
            // by inlineToolCallImages(from:), so they are not duplicated here.

            // Output with diff coloring + copy button
            if let result = toolCall.result, !result.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Output")
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.contentTertiary)
                        .textCase(.uppercase)

                    outputBlock(
                        text: nil,
                        attributedText: coloredOutput(result, isError: toolCall.isError),
                        copyText: result,
                        copyLabel: "Copy output"
                    )
                }
                .padding(.horizontal, VSpacing.lg)
            }
        }
        .padding(.bottom, VSpacing.sm)
        .textSelection(.enabled)
    }

    // MARK: - Output Block

    /// Reusable output block with a height-bounded ScrollView for long outputs.
    @ViewBuilder
    private func outputBlock(
        text: String?,
        attributedText: AttributedString?,
        copyText: String,
        copyLabel: String
    ) -> some View {
        let lineCount = copyText.components(separatedBy: "\n").count
        let isLong = lineCount > 500 || copyText.count > 50_000

        ZStack(alignment: .topTrailing) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                if isLong {
                    // Content at 500+ lines always exceeds 400pt, so a fixed
                    // height lets sizeThatFits return without measuring content.
                    ScrollView {
                        outputTextView(text: text, attributedText: attributedText)
                    }
                    .frame(height: 400)
                } else if let attrText = attributedText {
                    Text(attrText)
                        .font(VFont.bodySmallDefault)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                } else if let plainText = text {
                    Text(plainText)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(VSpacing.sm)
            .padding(.trailing, VSpacing.xl) // reserve space for copy button
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(VColor.surfaceOverlay.opacity(0.6))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .stroke(VColor.borderBase, lineWidth: 0.5)
            )

            ChatEquatableButton(
                config: ChatButtonConfig(
                    label: copyLabel,
                    iconOnly: VIcon.copy.rawValue,
                    style: .ghost,
                    size: .regular,
                    iconSize: 24,
                    iconColorRole: .contentTertiary,
                    tooltip: nil,
                    isDisabled: false,
                    closureIdentity: copyText.hashValue
                )
            ) {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(copyText, forType: .string)
            }
            .equatable()
            .padding(VSpacing.xs)
        }
    }

    /// Text view used inside the ScrollView for long outputs.
    @ViewBuilder
    private func outputTextView(
        text: String?,
        attributedText: AttributedString?
    ) -> some View {
        if let attrText = attributedText {
            Text(attrText)
                .font(VFont.bodySmallDefault)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if let plainText = text {
            Text(plainText)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
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
                color = VColor.systemNegativeStrong
            } else if !isDiff {
                color = VColor.contentSecondary
            } else if line.hasPrefix("+") {
                color = VColor.systemPositiveStrong
            } else if line.hasPrefix("-") {
                color = VColor.systemNegativeStrong
            } else if line.hasPrefix("@@") {
                color = VColor.contentTertiary
            } else {
                color = VColor.contentSecondary
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
        case .approved: VColor.primaryBase
        case .denied: VColor.systemNegativeStrong
        default: VColor.contentTertiary
        }
    }

    var body: some View {
        HStack(spacing: VSpacing.xxs) {
            Group {
                switch state {
                case .approved:
                    VIconView(.circleCheck, size: 10)
                        .foregroundStyle(chipColor)
                case .denied:
                    VIconView(.circleAlert, size: 10)
                        .foregroundStyle(chipColor)
                case .timedOut:
                    VIconView(.clock, size: 10)
                        .foregroundStyle(chipColor)
                default:
                    EmptyView()
                }
            }

            Text(state == .approved || state == .denied ? label : "Timed Out")
                .font(VFont.labelSmall)
                .foregroundStyle(chipColor)
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
            .opacity(isPulsing ? 0.6 : 1.0)
            .animation(
                Animation.easeInOut(duration: 1.8).repeatForever(autoreverses: true),
                value: isPulsing
            )
            .task {
                guard !isPulsing else { return }
                isPulsing = true
            }
    }
}

// MARK: - Previews

#if DEBUG








#endif

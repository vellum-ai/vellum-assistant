import SwiftUI
import VellumAssistantShared
import Dispatch

// MARK: - ProgressExpandedItem

/// Represents a single item in a chronological expanded-content trace.
/// When `AssistantProgressView.expandedItems` is provided, the expanded
/// body renders these items in order instead of the default `toolCalls`
/// array, allowing thinking blocks to appear interleaved with tool calls.
enum ProgressExpandedItem: Identifiable {
    /// A tool call to render via `ToolCallStepDetailRow`.
    case toolCall(ToolCallData)
    /// A thinking block to render via `ThinkingStepDetailRow`.
    case thinking(content: String, expansionKey: String, isStreaming: Bool)

    var id: String {
        switch self {
        case .toolCall(let tc):
            return "tool:\(tc.id.uuidString)"
        case .thinking(_, let key, _):
            return "thinking:\(key)"
        }
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
    let expandedItems: [ProgressExpandedItem]?
    var onRehydrate: (() -> Void)?

    // Confirmation action callbacks (threaded from MessageListView)
    var onConfirmationAllow: ((String) -> Void)? = nil   // requestId
    var onConfirmationDeny: ((String) -> Void)? = nil     // requestId
    var onAlwaysAllow: ((String, String, String, String) -> Void)? = nil
    var onTemporaryAllow: ((String, String) -> Void)? = nil
    var activeConfirmationRequestId: String? = nil  // For keyboard focus

    /// Interaction state that must outlive lazy row churn. Owned by the parent
    /// (ChatBubble or MessageListContentView) and passed as a binding so
    /// expansion, override, and rehydration tracking survive view recycling.
    @Binding var progressUIState: ProgressCardUIState

    @Binding var suggestRuleToolCall: ToolCallData?
    @Binding var suggestRuleSuggestion: TrustRuleSuggestion?

    @State private var isExpanded: Bool
    @State private var startDate: Date
    @State private var processingStartDate: Date?
    @State private var isOverflowPopoverShown: Bool = false
    @State private var suppressNextExpand: Bool = false
    /// When the post-tool-completion thinking phase started (typically the last
    /// tool's `completedAt`). Nil until all tools complete and the card remains active.
    @State private var thinkingAfterToolsStartDate: Date?
    /// When the thinking phase ended (card transitioned to `.complete`).
    /// Nil while thinking is still in progress.
    @State private var thinkingAfterToolsEndDate: Date?
    /// When the card first transitioned to `.complete`. Independent of the
    /// thinking anchors — captured for every completion so the header total
    /// duration stays monotonic across the `.toolsCompleteThinking` → `.complete`
    /// transition even when the daemon never emitted `.processing`.
    @State private var cardCompletedAt: Date?

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
        expandedItems: [ProgressExpandedItem]? = nil,
        onRehydrate: (() -> Void)? = nil,
        onConfirmationAllow: ((String) -> Void)? = nil,
        onConfirmationDeny: ((String) -> Void)? = nil,
        onAlwaysAllow: ((String, String, String, String) -> Void)? = nil,
        onTemporaryAllow: ((String, String) -> Void)? = nil,
        activeConfirmationRequestId: String? = nil,
        progressUIState: Binding<ProgressCardUIState>,
        suggestRuleToolCall: Binding<ToolCallData?> = .constant(nil),
        suggestRuleSuggestion: Binding<TrustRuleSuggestion?> = .constant(nil)
    ) {
        self.toolCalls = toolCalls
        self.isStreaming = isStreaming
        self.hasText = hasText
        self.isProcessing = isProcessing
        self.processingStatusText = processingStatusText
        self.streamingCodePreview = streamingCodePreview
        self.streamingCodeToolName = streamingCodeToolName
        self.decidedConfirmations = decidedConfirmations
        self.expandedItems = expandedItems
        self.onRehydrate = onRehydrate
        self.onConfirmationAllow = onConfirmationAllow
        self.onConfirmationDeny = onConfirmationDeny
        self.onAlwaysAllow = onAlwaysAllow
        self.onTemporaryAllow = onTemporaryAllow
        self.activeConfirmationRequestId = activeConfirmationRequestId
        self._progressUIState = progressUIState
        self._suggestRuleToolCall = suggestRuleToolCall
        self._suggestRuleSuggestion = suggestRuleSuggestion
        let model = ProgressCardPresentationModel.build(
            toolCalls: toolCalls,
            decidedConfirmations: decidedConfirmations,
            context: ProgressCardPresentationModel.StreamingContext(
                isStreaming: isStreaming,
                hasText: hasText,
                isProcessing: isProcessing,
                streamingCodePreview: streamingCodePreview
            ),
            expandCompletedStepsFlag: MacOSClientFeatureFlagManager.shared.isEnabled("expand-completed-steps")
        )
        let initialStartDate = model.earliestStartedAt ?? Date()
        let initialProcessingStartDate: Date? = if isProcessing && (model.allComplete || !model.hasTools) {
            Date()
        } else {
            nil
        }
        // Seed thinking timestamps for view recycling.
        // If we have a persisted thinking duration (from a previous render that survived
        // through completion), reconstruct the dates. Otherwise, seed from model state.
        let cardKeyForInit = toolCalls.first?.id
        let persistedThinkingDuration = cardKeyForInit.flatMap {
            progressUIState.wrappedValue.thinkingDuration(for: $0)
        }
        let initialThinkingStart: Date?
        let initialThinkingEnd: Date?
        // Cross-wave guard: only rehydrate thinking anchors when the model is
        // actually in the `.complete` phase. If the view is recycled mid-wave
        // (e.g. wave 2 still running after wave 1 completed), `handlePhaseChange`
        // never fires for the current init — so the persisted duration from
        // wave 1 would otherwise get stitched onto wave 2's latest tool end,
        // synthesizing a bogus thinking row and re-introducing the stale-anchor
        // regression this PR is meant to prevent.
        if model.phase == .complete,
           let duration = persistedThinkingDuration,
           let latestEnd = model.latestCompletedAt {
            // Reconstruct from persisted duration
            initialThinkingStart = latestEnd
            initialThinkingEnd = latestEnd.addingTimeInterval(duration)
        } else if model.allComplete && model.hasTools {
            // Only seed the thinking anchor when the daemon has explicitly
            // signaled thinking-after-tools (.processing). .toolsCompleteThinking
            // is pure phase inference and would mislabel post-tool latency as
            // "Thinking" — see the synthetic ThinkingStepRow below.
            if model.phase == .processing {
                initialThinkingStart = model.latestCompletedAt ?? Date()
                initialThinkingEnd = nil
            } else {
                initialThinkingStart = nil
                initialThinkingEnd = nil
            }
        } else {
            initialThinkingStart = nil
            initialThinkingEnd = nil
        }
        // Seed from user override via ProgressCardUIState if one exists, otherwise use model's auto-expand.
        let cardKey = toolCalls.first?.id
        let resolved = progressUIState.wrappedValue.resolveCardExpanded(cardKey: cardKey, model: model)
        _isExpanded = State(initialValue: resolved)
        _startDate = State(initialValue: initialStartDate)
        _processingStartDate = State(initialValue: initialProcessingStartDate)
        _thinkingAfterToolsStartDate = State(initialValue: initialThinkingStart)
        _thinkingAfterToolsEndDate = State(initialValue: initialThinkingEnd)
        // Seed the completion anchor from persisted state first so rehydration
        // is lossless across view recycling. Falling back to `latestCompletedAt`
        // (last tool end) drops any post-tool thinking/latency tail and
        // re-introduces the duration regression the anchor exists to prevent.
        //
        // Cross-wave guard: if the view recycles mid-wave-2, the card's
        // `.complete` → `.toolRunning` transition happened while the view was
        // unmounted, so `handlePhaseChange` never got a chance to clear the
        // wave-1 anchor. Unconditionally restoring the persisted value would
        // re-introduce the exact regression this PR fixes. Only use the
        // persisted anchor when the current phase is still `.complete`, and
        // additionally discard it if a tool completed AFTER the anchor (a new
        // wave finished while the view was unmounted — the stored timestamp
        // no longer describes the card's final state).
        let persistedCardCompletedAt = cardKeyForInit.flatMap {
            progressUIState.wrappedValue.cardCompletedAt(for: $0)
        }
        let initialCardCompletedAt: Date? = {
            guard model.phase == .complete else { return nil }
            if let persisted = persistedCardCompletedAt {
                if let latest = model.latestCompletedAt, persisted < latest {
                    return latest
                }
                return persisted
            }
            return model.latestCompletedAt
        }()
        _cardCompletedAt = State(initialValue: initialCardCompletedAt)
    }

    /// Stable key for this progress card in `progressUIState.cardExpansionOverrides`.
    private var cardKey: UUID? { toolCalls.first?.id }

    // MARK: - Projected Presentation Model

    /// Builds the presentation model from current inputs. This replaces the old
    /// `DerivedProgressState.compute(...)` path — all O(n) aggregation now goes
    /// through the standalone, testable `ProgressCardPresentationModel.build`.
    private var model: ProgressCardPresentationModel {
        ProgressCardPresentationModel.build(
            toolCalls: toolCalls,
            decidedConfirmations: decidedConfirmations,
            context: ProgressCardPresentationModel.StreamingContext(
                isStreaming: isStreaming,
                hasText: hasText,
                isProcessing: isProcessing,
                streamingCodePreview: streamingCodePreview
            ),
            expandCompletedStepsFlag: MacOSClientFeatureFlagManager.shared.isEnabled("expand-completed-steps")
        )
    }

    private func completedHeadline(model: ProgressCardPresentationModel) -> String {
        var total: TimeInterval = 0
        for tc in toolCalls {
            if let s = tc.startedAt, let e = tc.completedAt {
                total += e.timeIntervalSince(s)
            }
        }
        if total < 0.05 { return "Completed \(toolCalls.count) step\(toolCalls.count == 1 ? "" : "s")" }
        return "Worked for \(VCollapsibleStepRowDurationFormatter.format(total))"
    }

    private func headlineText(for model: ProgressCardPresentationModel) -> String {
        switch model.phase {
        case .thinking:
            return "Thinking..."
        case .toolRunning:
            if let current = model.currentCall {
                if let reason = current.reasonDescription, !reason.isEmpty {
                    return reason
                }
                if current.toolName == "skill_execute" {
                    return model.skillExecuteLabel
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
            let activeBuildingStatus = model.lastIncompleteCall?.buildingStatus
            return ChatBubble.friendlyRunningLabel(rawName, buildingStatus: activeBuildingStatus)
        case .toolsCompleteThinking:
            if let lastTool = model.lastToolCall {
                if let reason = lastTool.reasonDescription, !reason.isEmpty {
                    return reason
                }
                if lastTool.toolName == "skill_execute" {
                    return model.skillExecuteLabel
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
            if model.hasDeniedToolCalls {
                if model.deniedCount > 0 {
                    return "Completed with \(model.deniedCount) blocked permission\(model.deniedCount == 1 ? "" : "s")"
                }
                return "Completed with blocked permissions"
            }
            return completedHeadline(model: model)
        case .denied:
            let primary = model.uniqueToolNamesSorted.first ?? "Tool"
            return ChatBubble.friendlyRunningLabel(primary) + " denied"
        }
    }

    // MARK: - Body

    var body: some View {
        // Build the presentation model once per body evaluation. All rendering
        // sub-views receive this cached value instead of recomputing it.
        let model = self.model
        let phase = model.phase

        VStack(alignment: .leading, spacing: 0) {
            // Header row (always visible)
            headerRow(model: model, phase: phase)

            // Expanded content
            if isExpanded {
                expandedContent(model: model, phase: phase)
                    .padding(.bottom, VSpacing.xs)
            }

            // Code preview (streaming code phase)
            if phase == .streamingCode, let code = streamingCodePreview {
                CodePreviewView(code: code)
                    .padding(EdgeInsets(top: 0, leading: VSpacing.sm, bottom: VSpacing.xs, trailing: VSpacing.sm))
            }
        }
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .animation(VAnimation.fast, value: isExpanded)
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
        .onChange(of: model.hasPendingConfirmation) { _, pending in
            handlePendingConfirmationChange(pending)
        }
        .onAppear {
            handleOnAppear()
        }
    }

    // MARK: - Change Handlers (extracted to reduce body type-check complexity)

    private func handleToolCallsChange(_ newToolCalls: [ToolCallData]) {
        guard !newToolCalls.isEmpty else { return }
        deferProgressStateMutation {
            syncStartDateFromModelIfNeeded()
        }
    }

    private func handleConfirmationsChange(_ newConfirmations: [ToolConfirmationData]) {
        guard !newConfirmations.isEmpty || model.earliestStartedAt != nil else { return }
        deferProgressStateMutation {
            syncStartDateFromModelIfNeeded()
        }
    }

    private func handlePhaseChange(_ newPhase: ProgressCardPhase) {
        let expandFlag = MacOSClientFeatureFlagManager.shared.isEnabled("expand-completed-steps")
        ChatDiagnosticsStore.shared.record(ChatDiagnosticEvent(
            kind: .progressCardTransition,
            reason: "phase_change:\(newPhase) group=\(model.groupId) phase=\(newPhase) expand_flag=\(expandFlag) completed=\(model.completedToolCount)/\(model.totalToolCount) denied=\(model.deniedCount) pending_confirm=\(model.hasPendingConfirmation) rehydrate=\(onRehydrate != nil)",
            toolCallCount: model.totalToolCount
        ))
        // Auto-expand when a step group completes, if the flag is enabled.
        // Skip if the user has explicitly set a preference for this card.
        let hasUserCardPreference: Bool = {
            guard let key = cardKey else { return false }
            return progressUIState.cardExpansionOverride(for: key) != nil
        }()
        let shouldAutoExpandOnPhaseChange = (newPhase == .complete || newPhase == .denied)
            && !hasUserCardPreference
            && MacOSClientFeatureFlagManager.shared.isEnabled("expand-completed-steps")
        deferProgressStateMutation {
            if newPhase == .processing, model.phase == .processing {
                processingStartDate = Date()
                if model.earliestStartedAt == nil {
                    startDate = Date()
                }
            }
            // Reset thinking + completion anchors when tools resume. Also reset on
            // streamingCode when tools are still incomplete — phase resolution
            // returns streamingCode before toolRunning whenever a code preview
            // lingers, so in multi-wave runs the card can skip toolRunning and
            // keep a stale anchor from the previous wave. Without clearing
            // `cardCompletedAt` here the guard below (`cardCompletedAt == nil`)
            // would block the second `.complete` from updating it, leaving the
            // header stuck on wave 1's end time.
            if newPhase == .toolRunning
                || (newPhase == .streamingCode && !model.allComplete && model.hasTools) {
                thinkingAfterToolsStartDate = nil
                thinkingAfterToolsEndDate = nil
                cardCompletedAt = nil
                if let key = cardKey {
                    progressUIState.clearCardCompletedAt(for: key)
                    progressUIState.clearThinkingDuration(for: key)
                }
            }
            // Track thinking phase start only when the daemon explicitly
            // signaled thinking-after-tools. .processing fires only when
            // isProcessing is true, which the daemon emits on the first
            // thinking_delta following a tool completion (see
            // handleThinkingDelta in conversation-agent-loop-handlers.ts).
            // .toolsCompleteThinking is pure phase inference and does not
            // imply real thinking happened — gating on it would mislabel
            // post-tool network/first-token latency as "Thinking".
            if newPhase == .processing
                && model.allComplete && model.hasTools
                && thinkingAfterToolsStartDate == nil {
                thinkingAfterToolsStartDate = model.latestCompletedAt ?? Date()
            }
            // Track thinking phase end: card transitioned to complete.
            if newPhase == .complete, let thinkingStart = thinkingAfterToolsStartDate, thinkingAfterToolsEndDate == nil {
                let now = Date()
                thinkingAfterToolsEndDate = now
                // Persist duration so it survives view recycling.
                if let key = cardKey {
                    let duration = now.timeIntervalSince(thinkingStart)
                    progressUIState.setThinkingDuration(for: key, duration: duration)
                }
            }
            // Anchor the card's completion time on the first `.complete` transition.
            // Unlike the thinking anchor above this fires regardless of whether
            // `.processing` was ever observed, keeping the header total monotonic
            // when the daemon skips straight from `.toolsCompleteThinking`.
            // Persist on the shared state so the anchor survives view recycling.
            if newPhase == .complete, cardCompletedAt == nil {
                let now = Date()
                cardCompletedAt = now
                if let key = cardKey {
                    progressUIState.setCardCompletedAt(for: key, date: now)
                }
            }
            if shouldAutoExpandOnPhaseChange, !isExpanded {
                ChatDiagnosticsStore.shared.record(ChatDiagnosticEvent(
                    kind: .progressCardTransition,
                    reason: "auto_expand:completed_steps_flag group=\(model.groupId) phase=\(newPhase) expand_flag=true completed=\(model.completedToolCount)/\(model.totalToolCount) pending_confirm=\(model.hasPendingConfirmation) rehydrate=\(onRehydrate != nil)",
                    toolCallCount: model.totalToolCount
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
            if model.hasStrippedToolCalls {
                // Track rehydration in ProgressCardUIState to prevent redundant calls
                if let key = cardKey {
                    progressUIState.markRehydrated(groupId: key)
                }
                onRehydrate?()
            }
        }
    }

    private func handlePendingConfirmationChange(_ pending: Bool) {
        // Pending confirmations always force-expand — user must be able to
        // see and interact with the approval UI.
        guard pending else { return }
        deferProgressStateMutation {
            guard model.hasPendingConfirmation, !isExpanded else { return }
            ChatDiagnosticsStore.shared.record(ChatDiagnosticEvent(
                kind: .progressCardTransition,
                reason: "auto_expand:pending_confirmation",
                toolCallCount: model.totalToolCount
            ))
            withAnimation(VAnimation.fast) {
                isExpanded = true
            }
        }
    }

    private func handleOnAppear() {
        let wasExpandedOnEntry = isExpanded
        let shouldAutoExpandPendingOnAppear = model.hasPendingConfirmation && !isExpanded
        let shouldRehydrateOnAppear = wasExpandedOnEntry && onRehydrate != nil && model.hasStrippedToolCalls

        deferProgressStateMutation {
            syncStartDateFromModelIfNeeded()
            if model.phase == .processing && processingStartDate == nil {
                processingStartDate = Date()
                if model.earliestStartedAt == nil {
                    startDate = Date()
                }
            }

            if shouldAutoExpandPendingOnAppear && model.hasPendingConfirmation && !isExpanded {
                ChatDiagnosticsStore.shared.record(ChatDiagnosticEvent(
                    kind: .progressCardTransition,
                    reason: "auto_expand:pending_confirmation_on_appear",
                    toolCallCount: model.totalToolCount
                ))
                withAnimation(VAnimation.fast) {
                    isExpanded = true
                }
            }

            if shouldRehydrateOnAppear {
                if let key = cardKey {
                    progressUIState.markRehydrated(groupId: key)
                }
                onRehydrate?()
            }
        }
    }

    private func deferProgressStateMutation(_ update: @escaping @MainActor () -> Void) {
        DispatchQueue.main.async {
            Task { @MainActor in
                update()
            }
        }
    }

    /// Calls the suggest API for a tool call and opens the rule editor with the result.
    @MainActor
    private func fetchSuggestionAndOpenEditor(for toolCall: ToolCallData) async {
        let client = TrustRuleClient()
        // Priority: prefer the Minimatch-glob save-path ladder
        // (`riskAllowlistOptions`) because that is what the chips render and
        // what the rule editor will persist — feeding the LLM the same
        // pattern shapes it can save. Fall back to the regex-shaped legacy
        // `riskScopeOptions` ladder for tool calls without allowlist
        // coverage yet (and for the pre-tool_result "Allow and Create Rule"
        // path where the daemon may not have populated either field yet, in
        // which case both are empty and the suggester runs on command text
        // alone — same behavior as before #29826).
        let scopeOpts: [(pattern: String, label: String)] = {
            if let allowlist = toolCall.riskAllowlistOptions, !allowlist.isEmpty {
                return allowlist.map { (pattern: $0.pattern, label: $0.label) }
            }
            return (toolCall.riskScopeOptions ?? []).map { (pattern: $0.pattern, label: $0.label) }
        }()
        let dirScopeOpts: [(scope: String, label: String)] = (toolCall.riskDirectoryScopeOptions ?? []).map {
            (scope: $0.scope, label: $0.label)
        }
        // Use the full command text for the LLM — inputSummary is truncated to ~80 chars.
        let fullCommand: String = {
            if !toolCall.inputFull.isEmpty { return toolCall.inputFull }
            if let dict = toolCall.inputRawDict { return ToolCallData.formatAllToolInput(dict) }
            return toolCall.inputSummary
        }()
        do {
            let suggestion = try await client.suggestRule(
                tool: toolCall.toolName,
                command: fullCommand,
                riskAssessment: (
                    risk: toolCall.riskLevel ?? "medium",
                    reasoning: toolCall.riskReason ?? "",
                    reasonDescription: toolCall.reasonDescription ?? ""
                ),
                scopeOptions: scopeOpts,
                directoryScopeOptions: dirScopeOpts,
                intent: "auto_approve"
            )
            suggestRuleSuggestion = suggestion
            suggestRuleToolCall = toolCall
        } catch {
            // Suggestion failed — fall back to opening the rule editor without a suggestion.
            suggestRuleSuggestion = nil
            suggestRuleToolCall = toolCall
        }
    }

    @MainActor
    private func syncStartDateFromModelIfNeeded() {
        if let earliest = model.earliestStartedAt, startDate != earliest {
            startDate = earliest
        }
    }

    // MARK: - Header Row

    private func headerRow(model: ProgressCardPresentationModel, phase: ProgressCardPhase) -> some View {
        Button(action: {
            if suppressNextExpand {
                suppressNextExpand = false
                return
            }
            guard model.hasTools else { return }
            // Prevent collapsing while a confirmation is pending — the inline
            // bubble is the only visible approval UI when the standalone is suppressed.
            if isExpanded && model.hasPendingConfirmation { return }
            ChatDiagnosticsStore.shared.record(ChatDiagnosticEvent(
                kind: .progressCardTransition,
                reason: "manual_toggle:\(isExpanded ? "collapse" : "expand")",
                toolCallCount: model.totalToolCount
            ))
            withAnimation(VAnimation.fast) {
                isExpanded.toggle()
            }
            if let key = cardKey { progressUIState.setCardExpansionOverride(cardKey: key, expanded: isExpanded) }
        }) {
            // Let SwiftUI choose the compact variant instead of toggling local
            // state from a geometry callback, which can create layout feedback
            // loops while the progress card is updating mid-send.
            ViewThatFits(in: .horizontal) {
                headerRowContent(model: model, phase: phase, showInlinePermissionChips: !isExpanded)
                headerRowContent(model: model, phase: phase, showInlinePermissionChips: false)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .environment(\.isEnabled, true)
        .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.sm, bottom: VSpacing.xs, trailing: VSpacing.sm))
    }

    @ViewBuilder
    private func headerRowContent(model: ProgressCardPresentationModel, phase: ProgressCardPhase, showInlinePermissionChips: Bool) -> some View {
        HStack(spacing: VSpacing.sm) {
            // Status icon
            statusIcon(model: model, phase: phase)

            // Headline text with cross-fade
            headlineLabel(model: model, phase: phase)

            if showInlinePermissionChips {
                inlinePermissionChips
            }

            Spacer()

            // Elapsed time: live counter when active
            if model.isActive {
                ElapsedTimeLabel(startDate: startDate)
            }

            // Chevron (only if tools exist)
            if model.hasTools {
                VIconView(isExpanded ? .chevronUp : .chevronDown, size: 9)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    // MARK: - Status Icon

    @ViewBuilder
    private func statusIcon(model: ProgressCardPresentationModel, phase: ProgressCardPhase) -> some View {
        switch phase {
        case .complete:
            VIconView(model.hasDeniedToolCalls ? .triangleAlert : .circleCheck, size: 12)
                .foregroundStyle(model.hasDeniedToolCalls ? VColor.systemNegativeHover : VColor.primaryBase)
        case .denied:
            if decidedConfirmations.contains(where: { $0.state == .timedOut }) {
                VIconView(.clock, size: 12)
                    .foregroundStyle(VColor.contentTertiary)
            } else {
                VIconView(.circleAlert, size: 12)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
        default:
            VBusyIndicator(size: 8)
        }
    }

    // MARK: - Headline Label

    private func headlineLabel(model: ProgressCardPresentationModel, phase: ProgressCardPhase) -> some View {
        let text = headlineText(for: model)
        return Group {
            if phase == .processing {
                ProcessingDotsLabel(
                    processingStatusText: processingStatusText,
                    anchor: processingStartDate ?? Date()
                )
            } else {
                Text(ToolCallData.displaySafe(text))
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .animation(.easeInOut(duration: 0.3), value: text)
            }
        }
    }

    // MARK: - Expanded Content

    /// Derives a `Binding<Bool>` for a single step's expansion state from the
    /// shared `ProgressCardUIState`. The binding is scoped to one tool call ID
    /// so the shared `VCollapsibleStepRow` can use it as a drop-in replacement
    /// for `@State`.
    private func isStepExpanded(_ id: UUID) -> Binding<Bool> {
        Binding(
            get: { progressUIState.isStepExpanded(id) },
            set: { newValue in
                progressUIState.setStepExpanded(id, expanded: newValue)
            }
        )
    }

    /// Renders a single tool call row with its inline confirmation bubble.
    /// Extracted from `expandedContent` so the same rendering logic is shared
    /// between the default `toolCalls` path and the `expandedItems` path.
    @ViewBuilder
    private func toolCallRow(toolCall: ToolCallData, model: ProgressCardPresentationModel, phase: ProgressCardPhase) -> some View {
        ToolCallStepDetailRow(
            toolCall: toolCall,
            phase: phase,
            isDetailExpanded: isStepExpanded(toolCall.id),
            skillLabel: toolCall.toolName == "skill_execute" ? model.skillExecuteLabel : nil,
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
                onTemporaryAllow: onTemporaryAllow,
                onAllowAndSuggestRule: {
                    // Allow the tool first
                    if let option = confirmation.allowlistOptions.first, !option.pattern.isEmpty {
                        let scope = confirmation.scopeOptions.first?.scope ?? "everywhere"
                        onAlwaysAllow?(confirmation.requestId, option.pattern, scope, "allow")
                    } else {
                        onConfirmationAllow?(confirmation.requestId)
                    }
                    // Fire the suggest API and open the rule editor with the result
                    Task {
                        await fetchSuggestionAndOpenEditor(for: toolCall)
                    }
                }
            )
            .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.sm, bottom: VSpacing.xs, trailing: VSpacing.sm))
        }
    }

    /// Derives a `Binding<Bool>` for a thinking block's expansion state from the
    /// shared `ProgressCardUIState`. Scoped to one string key so
    /// `ThinkingStepDetailRow` can use it as a drop-in `@Binding`.
    private func isThinkingExpanded(_ key: String) -> Binding<Bool> {
        Binding(
            get: { progressUIState.isThinkingExpanded(key) },
            set: { newValue in
                progressUIState.setThinkingExpanded(key, expanded: newValue)
            }
        )
    }

    @ViewBuilder
    private func expandedContent(model: ProgressCardPresentationModel, phase: ProgressCardPhase) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let items = expandedItems {
                // Chronological trace with interleaved tool calls and thinking blocks.
                ForEach(items) { item in
                    switch item {
                    case .toolCall(let tc):
                        toolCallRow(toolCall: tc, model: model, phase: phase)
                    case .thinking(let content, let key, let streaming):
                        ThinkingStepDetailRow(
                            content: content,
                            isStreaming: streaming,
                            isExpanded: isThinkingExpanded(key)
                        )
                    }
                }
                // No synthetic ThinkingStepRow — thinking content is already
                // represented in the chronological trace above.
            } else {
                // Default path: render tool calls from the flat array.
                ForEach(toolCalls) { toolCall in
                    toolCallRow(toolCall: toolCall, model: model, phase: phase)
                }

                // Synthetic "Thinking" row for the post-tool-completion thinking phase.
                if let thinkingStart = thinkingAfterToolsStartDate, model.allComplete, model.hasTools {
                    ThinkingStepRow(
                        startDate: thinkingStart,
                        completedAt: thinkingAfterToolsEndDate,
                        isActive: model.isActive
                    )
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
                        .padding(EdgeInsets(top: VSpacing.xxs, leading: VSpacing.xs, bottom: VSpacing.xxs, trailing: VSpacing.xs))
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

// MARK: - Tool Call Step Detail Row

private final class StepDetailAttributedStringCacheEntry: NSObject {
    let value: AttributedString

    init(_ value: AttributedString) {
        self.value = value
    }
}

/// Chat-side adapter that wraps the shared `VCollapsibleStepRow` with the
/// chat-domain concerns that live on every tool call: risk badges, permission
/// chips, and the rule-editor modal sheet. The shared row handles the header
/// chrome; this wrapper builds the title string, resolves the visual state,
/// and renders the expanded "Technical details / Output" body specific to
/// `ToolCallData`.
///
/// `internal` rather than `private` so unit tests can reach the static
/// `acp_spawn` deep-link helper (`applyACPSessionDeepLink`) without
/// standing up the full SwiftUI view tree. Production callers stay scoped
/// to this file.
struct ToolCallStepDetailRow: View {

    let toolCall: ToolCallData
    let phase: ProgressCardPhase
    /// Expansion state lifted to ChatBubble so it survives the
    /// trailing→interleaved rendering path switch mid-stream.
    @Binding var isDetailExpanded: Bool
    /// Human-friendly label for skill_execute rows (e.g. "Using my frontend design skill").
    var skillLabel: String?
    var onRehydrate: (() -> Void)?

    /// Drives the Rule Editor Modal sheet presentation. Set to a tool call
    /// when the user taps a risk badge in the expanded view.
    @State private var ruleEditorToolCall: ToolCallData?
    /// LLM-generated suggestion to pre-populate the rule editor.
    @State private var ruleEditorSuggestion: TrustRuleSuggestion?
    /// Existing trust rule that matched this tool call, or nil for create mode.
    @State private var ruleEditorExistingRule: TrustRule?
    /// Tracks the in-flight suggestion task so it can be cancelled on re-open or dismiss.
    @State private var suggestionTask: Task<Void, Never>?
    /// Tracks the outer badge-tap task (fetchMatchedRule + modal open) so rapid taps don't race.
    @State private var ruleEditorTask: Task<Void, Never>?
    /// Set when a trust-rule save fails so we can surface an alert to the user.
    @State private var ruleSaveError: String?

    /// Shared across all rows — `TrustRuleClient` is a stateless HTTP client,
    /// so a single static instance avoids re-creation on every view rebuild.
    private static let trustRuleClient = TrustRuleClient()

    private static let coloredOutputCache: NSCache<NSString, StepDetailAttributedStringCacheEntry> = {
        let cache = NSCache<NSString, StepDetailAttributedStringCacheEntry>()
        cache.countLimit = 128
        return cache
    }()

    /// Lazily resolved full input text.
    private var resolvedInputFull: String {
        if !toolCall.inputFull.isEmpty { return toolCall.inputFull }
        if let dict = toolCall.inputRawDict { return ToolCallData.formatAllToolInput(dict) }
        return ""
    }

    /// Render-time memoization that stays off SwiftUI-owned state.
    private var cachedColoredResult: AttributedString? {
        guard let result = toolCall.result, !result.isEmpty else { return nil }
        let key = Self.coloredOutputCacheKey(
            toolCallID: toolCall.id.uuidString,
            resultRevision: toolCall.resultRevision,
            isError: toolCall.isError
        )
        if let cached = Self.coloredOutputCache.object(forKey: key) {
            return cached.value
        }

        let colored = coloredOutput(result, isError: toolCall.isError)
        Self.coloredOutputCache.setObject(StepDetailAttributedStringCacheEntry(colored), forKey: key)
        return colored
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

    /// Maps the tool call + progress phase into the neutral row state the
    /// shared `VCollapsibleStepRow` consumes. Running rows that completed with
    /// an error resolve to `.failed` so the icon and title color both flip.
    private var rowState: VCollapsibleStepRowState {
        if toolCall.isComplete {
            return toolCall.isError ? .failed : .succeeded
        }
        if phase == .denied {
            return .denied
        }
        return .running
    }

    /// Returns the `acpSessionId` payload field when this row should render
    /// as a tap-to-open `acp_spawn` shortcut. Nil for any other tool, for
    /// errored / still-running spawns, or when the result JSON is missing
    /// or unparseable. Restricting to successful, complete spawns keeps the
    /// chat-side behaviour unsurprising — a still-running or failed spawn
    /// has no detail view to jump to, so the row falls back to the regular
    /// expandable shape so the user can read the live output / error.
    ///
    /// Delegates payload parsing to ``ToolCallProgressBar/extractAcpSessionId(from:)``
    /// in `clients/shared/` so iOS and macOS accept identical payload shapes
    /// from a single implementation.
    var acpSessionIdToOpen: String? {
        guard CodingAgentsPanelFeatureFlag.isEnabled,
              toolCall.toolName == "acp_spawn",
              toolCall.isComplete,
              !toolCall.isError,
              let result = toolCall.result,
              !result.isEmpty else {
            return nil
        }
        return ToolCallProgressBar.extractAcpSessionId(from: result)
    }

    var body: some View {
        Group {
            if let acpSessionId = acpSessionIdToOpen {
                acpSpawnDeepLinkRow(acpSessionId: acpSessionId)
            } else {
                VCollapsibleStepRow(
                    title: ToolCallData.displaySafe(stepTitle),
                    state: rowState,
                    startedAt: toolCall.startedAt,
                    completedAt: toolCall.isComplete ? toolCall.completedAt : nil,
                    hasDetails: hasDetails,
                    isExpanded: $isDetailExpanded,
                    onExpand: { onRehydrate?() },
                    leadingAccessory: { leadingAccessory },
                    trailingAccessory: { trailingAccessory },
                    detailContent: { stepDetailContent }
                )
            }
        }
        .sheet(item: $ruleEditorToolCall) { tc in
            RuleEditorModal(
                toolName: tc.toolName,
                commandText: ToolCallStepDetailRow.commandDisplayText(from: tc),
                commandDescription: tc.reasonDescription ?? "",
                riskLevel: tc.riskLevel ?? "medium",
                scopeOptions: Self.scopeOptions(from: tc),
                directoryScopeOptions: tc.riskDirectoryScopeOptions ?? [],
                suggestion: ruleEditorSuggestion,
                existingRule: ruleEditorExistingRule,
                onSave: { rule in
                    let existingRule = ruleEditorExistingRule
                    Task {
                        do {
                            if let existingRule {
                                _ = try await Self.trustRuleClient.updateRule(
                                    id: existingRule.id,
                                    risk: rule.riskLevel,
                                    description: nil
                                )
                            } else {
                                _ = try await Self.trustRuleClient.createRule(
                                    tool: rule.toolName,
                                    pattern: rule.pattern,
                                    risk: rule.riskLevel,
                                    description: {
                                        let desc = tc.reasonDescription ?? ""
                                        return desc.isEmpty ? "\(rule.toolName) — \(rule.pattern)" : desc
                                    }(),
                                    scope: rule.scope
                                )
                            }
                        } catch {
                            ruleSaveError = error.localizedDescription
                        }
                    }
                },
                onSaveAsNew: { rule in
                    Task {
                        do {
                            _ = try await Self.trustRuleClient.createRule(
                                tool: rule.toolName,
                                pattern: rule.pattern,
                                risk: rule.riskLevel,
                                description: {
                                    let desc = tc.reasonDescription ?? ""
                                    return desc.isEmpty ? "\(rule.toolName) — \(rule.pattern)" : desc
                                }(),
                                scope: rule.scope
                            )
                        } catch {
                            ruleSaveError = error.localizedDescription
                        }
                    }
                },
                onDismiss: {
                    ruleEditorTask?.cancel()
                    ruleEditorTask = nil
                    suggestionTask?.cancel()
                    suggestionTask = nil
                    ruleEditorToolCall = nil
                    ruleEditorSuggestion = nil
                    ruleEditorExistingRule = nil
                }
            )
        }
        .alert(
            "Failed to Save Rule",
            isPresented: Binding(
                get: { ruleSaveError != nil },
                set: { if !$0 { ruleSaveError = nil } }
            ),
            actions: { Button("OK", role: .cancel) {} },
            message: { Text(ruleSaveError ?? "") }
        )
    }

    // MARK: - acp_spawn Deep Link

    /// Compact tap-to-open card replacing the standard `VCollapsibleStepRow`
    /// for completed `acp_spawn` tool calls. Visually mirrors the regular
    /// row's collapsed header so the chat transcript stays consistent, but
    /// substitutes the chevron-down with a chevron-right glyph to hint at
    /// "tap to navigate" rather than "tap to expand". The whole row is a
    /// `Button` so the tap target spans the full row width.
    ///
    /// The leading status dot is **live** — it subscribes to
    /// ``ACPSessionStore`` and re-renders as the daemon streams status
    /// updates for this session, so an inline block transitions
    /// running → completed/failed without the user expanding it. When the
    /// store has no entry for the session id (history cleared, daemon
    /// restarted) the dot falls back to the static tool-call result so a
    /// successful spawn still reads as "completed".
    @ViewBuilder
    private func acpSpawnDeepLinkRow(acpSessionId: String) -> some View {
        Button {
            Self.openACPSession(id: acpSessionId)
        } label: {
            HStack(spacing: VSpacing.sm) {
                ACPSpawnStatusDot(
                    acpSessionId: acpSessionId,
                    store: AppDelegate.shared?.services.acpSessionStore
                )
                .frame(width: 16)
                Text(ToolCallData.displaySafe(stepTitle))
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
                if let started = toolCall.startedAt,
                   let completed = toolCall.completedAt,
                   completed.timeIntervalSince(started) >= 0.05 {
                    Text(VCollapsibleStepRowDurationFormatter.format(completed.timeIntervalSince(started)))
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.contentTertiary)
                }
                VIconView(.chevronRight, size: 9)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .contentShape(Rectangle())
            .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.sm + VSpacing.sm, bottom: VSpacing.xs, trailing: VSpacing.xs + VSpacing.xs))
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .accessibilityLabel("\(ToolCallData.displaySafe(stepTitle)). Tap to open coding agent session.")
    }

    /// Drive the right-slot panel + detail-view deep link. Routes through
    /// the shared `MainWindowState` and `ACPSessionStore` instances on the
    /// app delegate — no environment plumbing needed because the action is
    /// fire-and-forget and only one of each store ever exists per process.
    /// The panel observes `selectedSessionId` and pushes the matching view
    /// model onto its `NavigationStack`; the layout-config mutation makes
    /// the panel itself visible if it isn't already.
    ///
    /// `internal` and `static` so unit tests can exercise the side effects
    /// against an injected `MainWindowState` / `ACPSessionStore` pair.
    static func openACPSession(id: String) {
        guard CodingAgentsPanelFeatureFlag.isEnabled else { return }
        guard let appDelegate = AppDelegate.shared else { return }
        applyACPSessionDeepLink(
            id: id,
            windowState: appDelegate.mainWindow?.windowState,
            store: appDelegate.services.acpSessionStore
        )
    }

    /// Pure side-effect helper for ``openACPSession(id:)``. Set the right
    /// slot to `.native(.acpSessions)` and mark it visible, then poke the
    /// store so the panel pushes the matching detail view. Either argument
    /// being nil is a no-op — both are required for the deep link to land.
    @MainActor
    static func applyACPSessionDeepLink(
        id: String,
        windowState: MainWindowState?,
        store: ACPSessionStore?
    ) {
        guard CodingAgentsPanelFeatureFlag.isEnabled,
              let windowState,
              let store else { return }
        windowState.showRightSlot(.native(.acpSessions))
        // Setting the id triggers ``ACPSessionsPanel/consumeSelectedSessionIdIfPresent``
        // which pushes the matching view model onto the panel's
        // `NavigationStack`. If the spawn event hasn't streamed in yet
        // the panel will land on the list and the user can re-tap once
        // the row appears — the daemon emits `acp_session_spawned`
        // synchronously with the tool result so this race is rare.
        store.selectedSessionId = id
    }

    // MARK: - Accessories

    /// Risk badge rendered immediately after the title.
    /// Chat-specific, so it stays at this caller level rather than in the shared row.
    @ViewBuilder
    private var leadingAccessory: some View {
        if let risk = toolCall.riskLevel {
            let unexpected = !wasExpected(
                approvalMode: toolCall.approvalMode,
                riskLevel: toolCall.riskLevel,
                riskThreshold: toolCall.riskThreshold
            )
            let provenance = unexpected
                ? approvalProvenanceText(approvalReason: toolCall.approvalReason)
                : nil
            RiskBadgeView(
                riskLevel: risk,
                hasExistingRule: toolCall.matchedTrustRuleId != nil,
                provenanceText: provenance
            ) {
                ruleEditorTask?.cancel()
                ruleEditorTask = Task { await openRuleEditorForCompletedCall(toolCall) }
            }
        }
    }

    /// Permission chip rendered before the duration label on the right side.
    /// The original layout left an extra `xs` of trailing padding between the
    /// chip and the duration — preserved via `.padding(.trailing, xs)` so the
    /// pixel-level spacing is identical.
    @ViewBuilder
    private var trailingAccessory: some View {
        if let decision = toolCall.confirmationDecision {
            CompactPermissionChip(
                state: decision,
                label: toolCall.confirmationLabel ?? toolCall.friendlyName
            )
            .padding(.trailing, VSpacing.xs)
        }
    }

    // MARK: - Scope Options

    /// Constructs scope option items from the tool call's risk options for the
    /// Rule Editor modal "Apply to" chip ladder.
    ///
    /// Priority order (narrowest correct shape wins):
    ///   1. `riskAllowlistOptions` — Minimatch-glob patterns produced by the
    ///      classifier. This is the **save-correct** shape: the gateway
    ///      matches saved trust rules as Minimatch globs, so chips built from
    ///      this field actually fire on subsequent invocations.
    ///   2. `riskScopeOptions` — display-shape regex patterns (legacy).
    ///      Useful as a UI fallback only; saving these patterns produces
    ///      ghost rules that look saved but never match. Kept here so we
    ///      don't lose the chip ladder for tools whose classifiers haven't
    ///      yet been migrated to emit allowlistOptions.
    ///   3. Synthesized "*" wildcard when neither field is populated (e.g.
    ///      for unclassified MCP tools or natural-language activity strings
    ///      like `remember`).
    static func scopeOptions(from toolCall: ToolCallData) -> [ScopeOptionItem] {
        if let allowlist = toolCall.riskAllowlistOptions, !allowlist.isEmpty {
            return allowlist.map { option in
                ScopeOptionItem(
                    label: option.label,
                    pattern: option.pattern
                )
            }
        }
        if let options = toolCall.riskScopeOptions, !options.isEmpty {
            return options.map { option in
                ScopeOptionItem(
                    label: option.label,
                    pattern: option.pattern
                )
            }
        }
        // Determine whether inputRawValue is a real command or just the
        // activity description. Priority-key tools (bash → `command`) give
        // a structured value; others fall through alphabetically and end up
        // with the natural-language activity text.
        let raw = toolCall.inputRawValue
        let isNaturalLanguage = !raw.isEmpty && raw == (toolCall.reasonDescription ?? "")
        let pattern = (isNaturalLanguage || raw.isEmpty) ? "*" : raw
        let label = pattern == "*"
            ? "Any \(toolCall.toolName) call"
            : pattern
        return [ScopeOptionItem(label: label, pattern: pattern)]
    }

    /// Returns the best structured text to display in the "Command" header of
    /// the Rule Editor Modal. Uses the full formatted input when `inputRawValue`
    /// is just the natural-language activity description (tools like `remember`
    /// that lack a priority key such as `command`/`path`/`url`); otherwise
    /// returns the raw primary value directly.
    static func commandDisplayText(from toolCall: ToolCallData) -> String {
        let raw = toolCall.inputRawValue
        let isNaturalLanguage = !raw.isEmpty && raw == (toolCall.reasonDescription ?? "")
        if isNaturalLanguage {
            if !toolCall.inputFull.isEmpty { return toolCall.inputFull }
            if let dict = toolCall.inputRawDict { return ToolCallData.formatAllToolInput(dict) }
        }
        return raw.isEmpty ? toolCall.inputSummary : raw
    }

    // MARK: - Rule Editor

    @MainActor
    private func openRuleEditorForCompletedCall(_ toolCall: ToolCallData) async {
        // Cancel any previous suggestion task and clear stale state before opening.
        suggestionTask?.cancel()
        suggestionTask = nil
        ruleEditorSuggestion = nil

        // Fetch the matched rule first (fast HTTP list) so the modal opens in the
        // correct create/edit mode. Suggestion fires in the background after open.
        let existingRule = try? await fetchMatchedRule(toolCall)
        guard !Task.isCancelled else { return }
        ruleEditorExistingRule = existingRule
        guard !Task.isCancelled else { return }
        ruleEditorToolCall = toolCall  // Opens the modal immediately

        // LLM suggestion fires while the modal is already visible. The modal
        // reacts via .onChange(of: suggestion?.pattern) in applySuggestionOrDefaults.
        suggestionTask = Task { @MainActor in
            guard let suggestion = try? await fetchSuggestionForEditor(toolCall, existingRule: existingRule) else { return }
            guard !Task.isCancelled else { return }
            ruleEditorSuggestion = suggestion
        }
    }

    private func fetchSuggestionForEditor(_ toolCall: ToolCallData, existingRule: TrustRule?) async throws -> TrustRuleSuggestion {
        // Same priority as `fetchSuggestionAndOpenEditor`: feed the LLM the
        // glob-shaped save-path ladder (the chips it can pick from), falling
        // back to the regex-shaped display ladder when allowlist coverage
        // is absent.
        let scopeOpts: [(pattern: String, label: String)] = {
            if let allowlist = toolCall.riskAllowlistOptions, !allowlist.isEmpty {
                return allowlist.map { (pattern: $0.pattern, label: $0.label) }
            }
            return (toolCall.riskScopeOptions ?? []).map { (pattern: $0.pattern, label: $0.label) }
        }()
        let dirScopeOpts: [(scope: String, label: String)] = (toolCall.riskDirectoryScopeOptions ?? []).map {
            (scope: $0.scope, label: $0.label)
        }
        let fullCommand: String = {
            if !toolCall.inputFull.isEmpty { return toolCall.inputFull }
            if let dict = toolCall.inputRawDict { return ToolCallData.formatAllToolInput(dict) }
            return toolCall.inputSummary
        }()
        return try await Self.trustRuleClient.suggestRule(
            tool: toolCall.toolName,
            command: fullCommand,
            riskAssessment: (
                risk: toolCall.riskLevel ?? "medium",
                reasoning: toolCall.riskReason ?? "",
                reasonDescription: toolCall.reasonDescription ?? ""
            ),
            scopeOptions: scopeOpts,
            directoryScopeOptions: dirScopeOpts,
            intent: "auto_approve",
            existingRule: existingRule.map { (id: $0.id, pattern: $0.pattern, risk: $0.risk) }
        )
    }

    private func fetchMatchedRule(_ toolCall: ToolCallData) async throws -> TrustRule {
        guard let matchedId = toolCall.matchedTrustRuleId else {
            throw TrustRuleClientError.notFound
        }
        // First try: user-relevant rules (user_defined + user-modified defaults).
        // This covers the common case and is a fast, targeted query.
        let userRules = try await Self.trustRuleClient.listRules(tool: toolCall.toolName)
        if let rule = userRules.first(where: { $0.id == matchedId }) {
            return rule
        }
        // Fallback: the matched rule may be an unmodified default rule, which the
        // userRelevantOnly filter excludes. Fetch default rules explicitly so the
        // modal opens in edit mode rather than incorrectly opening in create mode
        // (which would fail with a UNIQUE constraint when the user saves).
        let defaultRules = try await Self.trustRuleClient.listRules(origin: "default", tool: toolCall.toolName)
        guard let rule = defaultRules.first(where: { $0.id == matchedId }) else {
            throw TrustRuleClientError.notFound
        }
        return rule
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

                if let reason = toolCall.reasonDescription, !reason.isEmpty {
                    Text(toolCall.actionDescription)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
                Text(toolCall.friendlyName)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                if !resolvedInputFull.isEmpty {
                    outputBlock(
                        text: resolvedInputFull,
                        attributedText: nil,
                        copyText: resolvedInputFull,
                        copyLabel: "Copy input"
                    )
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

                    // Cached diff coloring now lives in a non-observable
                    // cache so expansion no longer mutates SwiftUI state.
                    outputBlock(
                        text: cachedColoredResult == nil ? result : nil,
                        attributedText: cachedColoredResult,
                        copyText: result,
                        copyLabel: "Copy output",
                        isError: toolCall.isError
                    )
                }
                .padding(.horizontal, VSpacing.lg)
            }
        }
        .padding(.bottom, VSpacing.sm)
        .textSelection(.enabled)
    }

    // MARK: - Output Block

    /// Reusable output block with copy button.
    /// The outer transcript owns vertical scrolling to avoid nested scroll-view
    /// hit-testing and responder churn inside expanded tool rows.
    @ViewBuilder
    private func outputBlock(
        text: String?,
        attributedText: AttributedString?,
        copyText: String,
        copyLabel: String,
        isError: Bool = false
    ) -> some View {
        ZStack(alignment: .topTrailing) {
            // ⚠️ No .frame(maxWidth:) in LazyVStack cells — see AGENTS.md.
            HStack(spacing: 0) {
                outputTextView(text: text, attributedText: attributedText, isError: isError)
                Spacer(minLength: 0)
            }
            .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.sm, bottom: VSpacing.sm, trailing: VSpacing.sm + VSpacing.xl))
            .background(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .fill(VColor.surfaceOverlay.opacity(0.6))
            )
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

    /// Shared text view used by the detail blocks.
    @ViewBuilder
    private func outputTextView(
        text: String?,
        attributedText: AttributedString?,
        isError: Bool = false
    ) -> some View {
        // ⚠️ No .frame(maxWidth:) in LazyVStack cells — see AGENTS.md.
        if let attrText = attributedText {
            HStack(spacing: 0) {
                Text(attrText)
                    .font(VFont.bodySmallDefault)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
        } else if let plainText = text {
            HStack(spacing: 0) {
                Text(plainText)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(isError ? VColor.systemNegativeStrong : VColor.contentSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: - Helpers

    private static func coloredOutputCacheKey(
        toolCallID: String,
        resultRevision: Int,
        isError: Bool
    ) -> NSString {
        // O(1) cache key. `resultRevision` is a monotonic counter bumped on every
        // write to `toolCall.result` (see ToolCallData), so it detects in-place
        // mutations (replay / correction / rehydration) without touching the
        // string contents on every SwiftUI re-render.
        return "\(toolCallID)|\(resultRevision)|\(isError ? "err" : "ok")" as NSString
    }

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

}

// MARK: - ACP Spawn Status Dot

/// Live status indicator for the inline `acp_spawn` deep-link row.
///
/// Reads the matching ``ACPSessionViewModel`` off the supplied store —
/// because `ACPSessionStore` is `@Observable`, simply touching
/// `store.sessions[id]?.state.status` inside `body` enrolls this view in
/// SwiftUI's per-property observation graph, so a daemon SSE update
/// flips the dot without a manual refresh. The store is optional
/// because the chat transcript renders inside test harnesses and
/// pre-launch contexts where ``AppDelegate/shared`` is nil; a missing
/// store falls through to the static-completed indicator.
///
/// The render decision is owned by the shared ``ACPSpawnStatusIndicator``
/// enum in `clients/shared/Features/Chat/ACPSpawnStatusIndicator.swift`;
/// iOS renders the same enum through `ACPSpawnStatusIndicatorView` in
/// `ToolCallProgressBar.swift`, so both platforms agree on the lifecycle
/// they show for any given session status.
private struct ACPSpawnStatusDot: View {
    let acpSessionId: String
    let store: ACPSessionStore?

    var body: some View {
        let status = store?.sessions[acpSessionId]?.state.status
        switch ACPSpawnStatusIndicator.resolve(forStatus: status) {
        case .pulsing:
            VBusyIndicator(size: 8)
        case .icon(let glyph, let role):
            VIconView(glyph.icon, size: 12)
                .foregroundStyle(role.color)
        }
    }
}

// MARK: - Thinking Step Row

/// Synthetic sub-activity row shown when all tool calls in a progress card have
/// completed but the assistant is still working (thinking/processing phase).
/// Explains the time gap between the last tool completion and the card's total
/// elapsed time.
private struct ThinkingStepRow: View {
    /// When thinking started (typically `latestCompletedAt` of the tool group).
    let startDate: Date
    /// When thinking ended. Nil while still active.
    let completedAt: Date?
    /// Whether the thinking phase is still in progress.
    let isActive: Bool

    /// Minimum thinking duration (in seconds) required to show this row.
    /// Prevents visual noise for fast completions where the model responds
    /// almost immediately after the last tool finishes.
    private static let minimumDisplayDuration: TimeInterval = 2.0

    /// Whether the row should be rendered at all. Suppressed for very short
    /// thinking phases that would just add clutter.
    var shouldDisplay: Bool {
        if isActive { return true }
        guard let end = completedAt else { return false }
        return end.timeIntervalSince(startDate) >= Self.minimumDisplayDuration
    }

    var body: some View {
        if shouldDisplay {
            HStack(spacing: VSpacing.sm) {
                if isActive {
                    VBusyIndicator(size: 6)
                        .frame(width: 16)
                } else {
                    VIconView(.circleCheck, size: 12)
                        .foregroundStyle(VColor.primaryBase)
                        .frame(width: 16)
                }

                Text("Thinking")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)

                Spacer()

                HStack(spacing: VSpacing.xs) {
                    if isActive {
                        ElapsedTimeLabel(startDate: startDate)
                    } else if let end = completedAt {
                        Text(VCollapsibleStepRowDurationFormatter.format(end.timeIntervalSince(startDate)))
                            .font(VFont.labelSmall)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                }
            }
            .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.sm + VSpacing.sm, bottom: VSpacing.xs, trailing: VSpacing.xs + VSpacing.xs))
        }
    }
}

// MARK: - Thinking Step Detail Row

/// Collapsible row for a thinking block inside a `ProgressExpandedItem` trace.
/// Uses `VCollapsibleStepRow` with a brain icon and secondary text styling.
/// Markdown segments are parsed lazily — only when the row is expanded — to
/// avoid blocking the main thread for collapsed thinking blocks.
private struct ThinkingStepDetailRow: View {
    let content: String
    let isStreaming: Bool
    @Binding var isExpanded: Bool

    @Environment(\.bubbleMaxWidth) private var bubbleMaxWidth

    /// Lazily parsed markdown segments. Populated on first expansion and
    /// refreshed when the content changes while expanded.
    @State private var cachedSegments: [MarkdownSegment] = []
    @State private var cachedContent: String = ""

    private var title: String {
        isStreaming ? "Thinking..." : "Thought process"
    }

    private var rowState: VCollapsibleStepRowState {
        isStreaming ? .running : .succeeded
    }

    /// Syncs the markdown segment cache when the row is expanded and the
    /// underlying content has changed. Mirrors the lazy-parse pattern used
    /// by `ThinkingBlockView`.
    private func syncCacheIfExpanded() {
        guard isExpanded, cachedContent != content else { return }
        cachedContent = content
        cachedSegments = parseMarkdownSegments(content)
    }

    var body: some View {
        VCollapsibleStepRow(
            title: title,
            state: rowState,
            hasDetails: !content.isEmpty,
            isExpanded: $isExpanded,
            leadingAccessory: {
                VIconView(.brain, size: 11)
                    .foregroundStyle(VColor.contentSecondary)
            },
            detailContent: {
                if !cachedSegments.isEmpty {
                    MarkdownSegmentView(
                        segments: cachedSegments,
                        isStreaming: isStreaming,
                        maxContentWidth: max(bubbleMaxWidth - 2 * VSpacing.sm, 0),
                        textColor: VColor.contentSecondary,
                        secondaryTextColor: VColor.contentTertiary,
                        mutedTextColor: VColor.contentTertiary,
                        tintColor: VColor.primaryBase,
                        codeTextColor: VColor.contentDefault,
                        codeBackgroundColor: VColor.surfaceBase
                    )
                    .padding(VSpacing.sm)
                }
            }
        )
        .onAppear { syncCacheIfExpanded() }
        .onChange(of: content) { _, _ in syncCacheIfExpanded() }
        .onChange(of: isExpanded) { _, _ in syncCacheIfExpanded() }
    }
}

// MARK: - Processing Dots Label (Timer-based)

/// Self-contained view for the processing phase label with animated dots.
/// Extracted so the periodic ticks (every 0.4s) only re-evaluate this
/// small subtree, not the entire progress card.
///
/// Uses `Timer.publish` on `.main` / `.common` instead of `TimelineView`
/// for the same reliability reasons as `ElapsedTimeLabel`.
private struct ProcessingDotsLabel: View {
    let processingStatusText: String?
    let anchor: Date
    @State private var now = Date()

    private let timer = Timer.publish(every: 0.4, on: .main, in: .common).autoconnect()

    var body: some View {
        let initialLabel = ChatBubble.friendlyProcessingLabel(processingStatusText)
        let pinLabel = processingStatusText?.lowercased().contains("compacting") == true
        let labels: [String] = pinLabel ? [initialLabel] : [
            initialLabel,
            "Putting this together",
            "Finalizing your response",
        ]

        let elapsed = max(0, now.timeIntervalSince(anchor))
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
        .onReceive(timer) { date in
            now = date
        }
    }
}

// MARK: - Elapsed Time Label (Timer-based)

/// Self-contained view for the elapsed time counter.
/// Extracted so the periodic ticks (every 1.0s) only re-evaluate this
/// small subtree, not the entire progress card.
///
/// Uses `Timer.publish` on `.main` / `.common` instead of `TimelineView`
/// because `TimelineView(.periodic)` can silently stop firing on macOS
/// when the view hierarchy is idle or during heavy layout passes, causing
/// the elapsed counter to freeze.
private struct ElapsedTimeLabel: View {
    let startDate: Date
    @State private var now = Date()

    private let timer = Timer.publish(every: 1.0, on: .main, in: .common).autoconnect()

    var body: some View {
        let elapsed = max(0, now.timeIntervalSince(startDate))
        Group {
            if elapsed >= 5 {
                Text(RunningIndicator.formatElapsed(elapsed))
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
        .onReceive(timer) { date in
            now = date
        }
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

            Text(state == .approved || state == .denied ? label : "Timed Out")
                .font(VFont.labelSmall)
                .foregroundStyle(chipColor)
        }
        .padding(EdgeInsets(top: VSpacing.xxs, leading: VSpacing.xs, bottom: VSpacing.xxs, trailing: VSpacing.xs))
        .overlay(
            Capsule().stroke(chipColor.opacity(0.3), lineWidth: 1)
        )
    }
}

// MARK: - Previews

#if DEBUG








#endif

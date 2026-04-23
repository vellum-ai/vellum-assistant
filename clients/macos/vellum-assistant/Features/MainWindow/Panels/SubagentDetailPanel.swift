import AppKit
import SwiftUI
import VellumAssistantShared

struct SubagentDetailPanel: View {
    let subagentId: String
    var viewModel: ChatViewModel
    var detailStore: SubagentDetailStore
    var showInspectButton: Bool = false
    var onAbort: (() -> Void)?
    var onRequestDetail: (() -> Void)?
    var onInspectMessage: ((String) -> Void)?
    var onClose: () -> Void
    @ObservedObject private var typographyObserver = VFont.typographyObserver

    private var subagentInfo: SubagentInfo? { viewModel.activeSubagents.first(where: { $0.id == subagentId }) }
    private var state: SubagentState? { detailStore.subagentStates[subagentId] }
    private var objective: String? { state?.objective }
    private var usage: SubagentUsageStats? { state?.usageStats }
    private var events: [SubagentEventItem] { state?.events ?? [] }
    private var isRunning: Bool { subagentInfo?.status == .running || subagentInfo?.status == .pending }

    /// Observed width of the event-list container, forwarded to
    /// `MarkdownSegmentView.maxContentWidth` so long markdown wraps to the
    /// panel instead of `VSpacing.chatBubbleMaxWidth` (wider than the panel).
    /// Safe to observe here — the container's width is driven by the enclosing
    /// ScrollView, not by child content, so there is no feedback loop.
    @State private var panelContentWidth: CGFloat = 0

    var body: some View {
        VSidePanel(title: subagentInfo?.label ?? "Subagent", titleFont: VFont.titleSmall, onClose: onClose, pinnedContent: {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                // Status + abort row
                HStack {
                    statusBadge
                    Spacer()
                    if isRunning {
                        Button(action: { onAbort?() }) {
                            HStack(spacing: VSpacing.xxs) {
                                VIconView(.square, size: 8)
                                Text("Abort")
                                    .font(VFont.labelDefault)
                            }
                            .foregroundStyle(VColor.systemNegativeStrong)
                            .padding(.horizontal, VSpacing.sm)
                            .padding(.vertical, VSpacing.xxs)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.pill)
                                    .fill(VColor.systemNegativeStrong.opacity(0.12))
                            )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Abort subagent")
                    }
                }

                // Objective
                if let objective, !objective.isEmpty {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("OBJECTIVE")
                            .font(VFont.labelSmall)
                            .foregroundStyle(VColor.contentTertiary)
                        Text(objective)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)
                    }
                }

                // Usage metrics row
                if let usage {
                    usageMetrics(usage)
                }

                // Error banner
                if let error = subagentInfo?.error, !error.isEmpty {
                    HStack(alignment: .top, spacing: VSpacing.xs) {
                        VIconView(.triangleAlert, size: 11)
                            .foregroundStyle(VColor.systemNegativeStrong)
                        Text(error)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.systemNegativeStrong)
                    }
                    .padding(VSpacing.sm)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .fill(VColor.systemNegativeStrong.opacity(0.08))
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.md)
                                    .strokeBorder(VColor.systemNegativeStrong.opacity(0.2), lineWidth: 1)
                            )
                    )
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.lg)

            Divider().background(VColor.borderBase)
        }) {
            if events.isEmpty {
                VEmptyState(
                    title: "No events yet",
                    subtitle: "Events will appear as the subagent runs",
                    icon: "waveform.path"
                )
            } else {
                eventList
                    .onGeometryChange(for: CGFloat.self) { proxy in
                        proxy.size.width
                    } action: { newWidth in
                        panelContentWidth = newWidth
                    }
            }
        }
        .onAppear {
            // Lazy-load events from DB when the panel opens for a completed subagent with no cached events
            if events.isEmpty, subagentInfo?.conversationId != nil {
                onRequestDetail?()
            }
        }
    }

    // MARK: - Event List

    /// Groups consecutive tool-call events into a single visual group when the
    /// subagent is terminal. Text / error events render inline in either mode.
    @ViewBuilder
    private var eventList: some View {
        let groups = isRunning
            ? SubagentEventGrouping.build(events: events)
            : SubagentEventGrouping.buildCompleted(events: events)
        LazyVStack(alignment: .leading, spacing: VSpacing.md) {
            ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                renderGroup(group)
            }
        }
    }

    @ViewBuilder
    private func renderGroup(_ group: SubagentEventGrouping.Group) -> some View {
        switch group {
        case .text(let event):
            textCell(event)
        case .error(let event):
            errorCell(event)
        case .toolCall(let pair):
            SubagentToolCallRow(pair: pair, isExpanded: expansionBinding(for: pair.id))
        case .orphanToolResult(let event):
            SubagentOrphanToolResultRow(event: event, isExpanded: expansionBinding(for: event.id))
        case .completedToolCalls(let pairs):
            completedToolCallsSection(pairs)
        }
    }

    /// The "Completed N events" section shown when the subagent is terminal.
    /// Mirrors the `AssistantProgressView.swift` main-thread pattern.
    ///
    /// Each group tracks its own expansion state via a per-group key — the
    /// first pair's `id` — so when text/error events split a run of tool
    /// calls into multiple `.completedToolCalls` groups, expanding one does
    /// not toggle the others. If `pairs.first?.id` is unexpectedly `nil`
    /// (empty group — should not happen), the section short-circuits.
    @ViewBuilder
    private func completedToolCallsSection(_ pairs: [SubagentToolCallPair]) -> some View {
        if let groupKey = pairs.first?.id {
            let groupBinding = Binding<Bool>(
                get: { state?.completedGroupExpandedIds.contains(groupKey) ?? false },
                set: { newValue in
                    if newValue {
                        state?.completedGroupExpandedIds.insert(groupKey)
                    } else {
                        state?.completedGroupExpandedIds.remove(groupKey)
                    }
                }
            )
            SubagentCompletedStepsHeader(
                count: pairs.count,
                totalDuration: SubagentEventGrouping.duration(across: pairs),
                isExpanded: groupBinding
            )
            if groupBinding.wrappedValue {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(pairs, id: \.id) { pair in
                        SubagentToolCallRow(pair: pair, isExpanded: expansionBinding(for: pair.id))
                    }
                }
            }
        }
    }

    private func expansionBinding(for id: UUID) -> Binding<Bool> {
        Binding(
            get: { state?.isEventExpanded(id) ?? false },
            set: { state?.setEventExpanded(id, expanded: $0) }
        )
    }

    // MARK: - Text & Error Cells

    @ViewBuilder
    private func textCell(_ event: SubagentEventItem) -> some View {
        // Subtract horizontal padding so markdown fits inside the rounded card.
        let markdownWidth: CGFloat? = panelContentWidth > 0
            ? max(panelContentWidth - 2 * VSpacing.sm, 0)
            : nil
        ZStack(alignment: .topTrailing) {
            HStack(spacing: 0) {
                MarkdownSegmentView(
                    segments: parseMarkdownSegments(event.content),
                    typographyGeneration: typographyObserver.generation,
                    maxContentWidth: markdownWidth
                )
                .equatable()
                .textSelection(.enabled)
                Spacer(minLength: 0)
            }
            .padding(VSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(VColor.surfaceBase.opacity(0.4))
            )

            SubagentTextActionOverlay(
                event: event,
                showInspectButton: showInspectButton,
                onInspectMessage: onInspectMessage
            )
        }
    }

    @ViewBuilder
    private func errorCell(_ event: SubagentEventItem) -> some View {
        HStack(alignment: .top, spacing: VSpacing.xs) {
            VIconView(.triangleAlert, size: 11)
                .foregroundStyle(VColor.systemNegativeStrong)
            Text(event.content)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.systemNegativeStrong)
                .textSelection(.enabled)
        }
        .padding(VSpacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.systemNegativeStrong.opacity(0.08))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .strokeBorder(VColor.systemNegativeStrong.opacity(0.15), lineWidth: 1)
                )
        )
    }

    // MARK: - Status Badge

    @ViewBuilder
    private var statusBadge: some View {
        if let info = subagentInfo {
            HStack(spacing: VSpacing.xs) {
                Circle()
                    .fill(statusColor(info.status))
                    .frame(width: 8, height: 8)
                Text(info.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(VFont.labelDefault)
                    .foregroundStyle(statusColor(info.status))
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xxs)
            .background(
                Capsule()
                    .fill(statusColor(info.status).opacity(0.12))
            )
        }
    }

    private func statusColor(_ status: SubagentStatus) -> Color {
        switch status {
        case .completed: return VColor.systemPositiveStrong
        case .failed, .aborted: return VColor.systemNegativeStrong
        case .running: return VColor.primaryActive
        default: return VColor.contentTertiary
        }
    }

    // MARK: - Usage Metrics

    @ViewBuilder
    private func usageMetrics(_ usage: SubagentUsageStats) -> some View {
        HStack(spacing: 0) {
            metricItem(icon: "arrow.down.circle", label: "Input", value: "\(formatNumber(usage.inputTokens)) tokens")
            Spacer()
            metricItem(icon: "arrow.up.circle", label: "Output", value: "\(formatNumber(usage.outputTokens)) tokens")
            Spacer()
            metricItem(icon: "dollarsign.circle", label: "Cost", value: formatCost(usage.estimatedCost))
        }
        .padding(.vertical, VSpacing.xs)
    }

    @ViewBuilder
    private func metricItem(icon: String, label: String, value: String) -> some View {
        HStack(spacing: VSpacing.xxs) {
            VIconView(SFSymbolMapping.icon(forSFSymbol: icon, fallback: .puzzle), size: 10)
                .foregroundStyle(VColor.contentTertiary)
            VStack(alignment: .leading, spacing: 0) {
                Text(label)
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
                Text(value)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
        }
    }

    // MARK: - Formatting

    private func formatNumber(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fK", Double(n) / 1_000) }
        return "\(n)"
    }

    private func formatCost(_ cost: Double) -> String {
        if cost == 0 { return UsageFormatting.formatCostShort(0) }
        if cost < 0.01 { return "<\(UsageFormatting.formatCostShort(0.01))" }
        return UsageFormatting.formatCostShort(cost)
    }
}

// MARK: - Event Grouping

/// Pure mapping from a flat `[SubagentEventItem]` stream into the visual
/// groups rendered by the panel. The grouping logic is deliberately isolated
/// from view code so it can be reasoned about on its own terms.
struct SubagentEventGrouping {
    enum Group {
        case text(SubagentEventItem)
        case error(SubagentEventItem)
        case toolCall(SubagentToolCallPair)
        /// A `.toolResult` event whose matching `.toolUse` is no longer in the
        /// retained window — `SubagentDetailStore.trimStagedEvents` drops the
        /// oldest events when the retention cap is hit, so on a long-running
        /// subagent the paired call may be gone while the result lingers. We
        /// still want the result (and any error payload) inspectable.
        case orphanToolResult(SubagentEventItem)
        case completedToolCalls([SubagentToolCallPair])
    }

    /// Build the visual groups for the running state (tool calls inline). Each
    /// `.toolUse` consumes an immediately-following `.toolResult` and renders
    /// as a single `.toolCall` pair. A `.toolResult` with no preceding
    /// `.toolUse` in the retained window is surfaced as an `.orphanToolResult`
    /// so retention-trimmed error output remains inspectable rather than
    /// disappearing from the UI.
    static func build(events: [SubagentEventItem]) -> [Group] {
        var groups: [Group] = []
        var i = 0
        while i < events.count {
            let event = events[i]
            switch event.kind {
            case .text:
                groups.append(.text(event))
                i += 1
            case .error:
                groups.append(.error(event))
                i += 1
            case .toolUse(let name):
                var result: SubagentEventItem?
                if i + 1 < events.count, case .toolResult = events[i + 1].kind {
                    result = events[i + 1]
                    i += 2
                } else {
                    i += 1
                }
                groups.append(.toolCall(SubagentToolCallPair(
                    callEvent: event,
                    resultEvent: result,
                    toolName: name
                )))
            case .toolResult:
                // Orphan — the paired `.toolUse` has been trimmed. Render the
                // result as a standalone row so error output stays visible.
                groups.append(.orphanToolResult(event))
                i += 1
            }
        }
        return groups
    }

    /// Build groups for the completed state: consecutive tool-call pairs get
    /// folded into a single `.completedToolCalls` group rendered under a
    /// collapsible header. Text/error groups break the run.
    static func buildCompleted(events: [SubagentEventItem]) -> [Group] {
        let raw = build(events: events)
        var groups: [Group] = []
        var pending: [SubagentToolCallPair] = []
        for group in raw {
            if case .toolCall(let pair) = group {
                pending.append(pair)
                continue
            }
            if !pending.isEmpty {
                groups.append(.completedToolCalls(pending))
                pending = []
            }
            groups.append(group)
        }
        if !pending.isEmpty {
            groups.append(.completedToolCalls(pending))
        }
        return groups
    }

    /// Total elapsed time spanning a contiguous run of tool calls. Uses the
    /// first pair's `startedAt` and the last pair's `completedAt` (falling
    /// back to its `startedAt` when the pair has no result).
    static func duration(across pairs: [SubagentToolCallPair]) -> TimeInterval? {
        guard let firstPair = pairs.first,
              let lastPair = pairs.last else {
            return nil
        }
        let first = firstPair.startedAt
        let last = lastPair.completedAt ?? lastPair.startedAt
        let delta = last.timeIntervalSince(first)
        return delta > 0 ? delta : nil
    }

}

/// A `.toolUse` event optionally paired with its subsequent `.toolResult`.
/// Carries the full data the collapsible row needs.
struct SubagentToolCallPair {
    let callEvent: SubagentEventItem
    let resultEvent: SubagentEventItem?
    let toolName: String

    var id: UUID { callEvent.id }
    var startedAt: Date { callEvent.timestamp }
    var completedAt: Date? { resultEvent?.timestamp }

    var resultIsError: Bool {
        guard let resultEvent, case .toolResult(let isError) = resultEvent.kind else { return false }
        return isError
    }

    var state: VCollapsibleStepRowState {
        guard resultEvent != nil else { return .running }
        return resultIsError ? .failed : .succeeded
    }

    var inputSummary: String { callEvent.content }
    var resultContent: String? { resultEvent?.content }

    var hasDetails: Bool {
        !inputSummary.isEmpty || (resultContent?.isEmpty == false)
    }
}

// MARK: - Tool Call Row

private struct SubagentToolCallRow: View {
    let pair: SubagentToolCallPair
    @Binding var isExpanded: Bool

    @State private var isHovered = false

    var body: some View {
        VCollapsibleStepRow(
            title: pair.toolName,
            state: pair.state,
            startedAt: pair.startedAt,
            completedAt: pair.completedAt,
            hasDetails: pair.hasDetails,
            isExpanded: $isExpanded,
            trailingAccessory: { trailingAccessory },
            detailContent: { detailContent }
        )
        .onHover { isHovered = $0 }
    }

    @ViewBuilder
    private var trailingAccessory: some View {
        if isHovered, !copyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            SubagentCopyButton(text: copyText)
                .transition(.opacity)
        }
    }

    private var copyText: String {
        [pair.inputSummary, pair.resultContent]
            .compactMap { $0 }
            .joined(separator: "\n\n")
    }

    @ViewBuilder
    private var detailContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Divider().padding(.horizontal, VSpacing.lg)

            if !pair.inputSummary.isEmpty {
                detailBlock(label: "INPUT", content: pair.inputSummary, isError: false)
            }
            if let result = pair.resultContent, !result.isEmpty {
                detailBlock(
                    label: pair.resultIsError ? "ERROR" : "OUTPUT",
                    content: result,
                    isError: pair.resultIsError
                )
            }
        }
        .padding(.bottom, VSpacing.sm)
    }

    @ViewBuilder
    private func detailBlock(label: String, content: String, isError: Bool) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(label)
                .font(VFont.labelSmall)
                .foregroundStyle(VColor.contentTertiary)
            Text(content)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(isError ? VColor.systemNegativeStrong : VColor.contentSecondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, VSpacing.lg)
    }
}

// MARK: - Orphan Tool Result Row

/// Renders a `.toolResult` event whose matching `.toolUse` has been trimmed
/// out of the retained event window. Mirrors the visual shape of
/// `SubagentToolCallRow` (collapsible, same expansion-state binding) so the
/// result content — especially error payloads — stays inspectable.
private struct SubagentOrphanToolResultRow: View {
    let event: SubagentEventItem
    @Binding var isExpanded: Bool

    @State private var isHovered = false

    private var isError: Bool {
        if case .toolResult(let err) = event.kind { return err }
        return false
    }

    private var title: String {
        isError ? "Tool error" : "Tool result"
    }

    private var state: VCollapsibleStepRowState {
        isError ? .failed : .succeeded
    }

    private var hasDetails: Bool {
        !event.content.isEmpty
    }

    var body: some View {
        VCollapsibleStepRow(
            title: title,
            state: state,
            startedAt: event.timestamp,
            completedAt: event.timestamp,
            hasDetails: hasDetails,
            isExpanded: $isExpanded,
            trailingAccessory: { trailingAccessory },
            detailContent: { detailContent }
        )
        .onHover { isHovered = $0 }
    }

    @ViewBuilder
    private var trailingAccessory: some View {
        if isHovered, !event.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            SubagentCopyButton(text: event.content)
                .transition(.opacity)
        }
    }

    @ViewBuilder
    private var detailContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Divider().padding(.horizontal, VSpacing.lg)

            if !event.content.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(isError ? "ERROR" : "OUTPUT")
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.contentTertiary)
                    Text(event.content)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(isError ? VColor.systemNegativeStrong : VColor.contentSecondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, VSpacing.lg)
            }
        }
        .padding(.bottom, VSpacing.sm)
    }
}

// MARK: - Text Event Action Overlay

/// Hover-revealed Copy / Inspect buttons for a `.text` event cell. Kept as a
/// distinct view so each row gets its own hover state.
private struct SubagentTextActionOverlay: View {
    let event: SubagentEventItem
    let showInspectButton: Bool
    var onInspectMessage: ((String) -> Void)?

    @State private var isHovered = false

    private var canInspect: Bool {
        showInspectButton && event.daemonMessageId != nil
    }

    private var hasCopyableContent: Bool {
        !event.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var showActions: Bool {
        isHovered && (hasCopyableContent || canInspect)
    }

    var body: some View {
        // Transparent hover catcher so the entire cell area participates while
        // the action buttons stay pinned to top-trailing.
        Color.clear
            .contentShape(Rectangle())
            .onHover { isHovered = $0 }
            .overlay(alignment: .topTrailing) {
                if showActions {
                    HStack(spacing: 2) {
                        if hasCopyableContent {
                            SubagentCopyButton(text: event.content)
                        }
                        if canInspect, let daemonMessageId = event.daemonMessageId {
                            ChatEquatableButton(
                                label: "Inspect LLM context",
                                iconOnly: VIcon.fileCode.rawValue
                            ) {
                                onInspectMessage?(daemonMessageId)
                            }
                            .equatable()
                            .vTooltip("Inspect", edge: .bottom)
                        }
                    }
                    .padding(VSpacing.xxs)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.sm)
                            .fill(VColor.surfaceOverlay.opacity(0.9))
                    )
                    .textSelection(.disabled)
                    .transition(.opacity)
                }
            }
            .animation(VAnimation.fast, value: showActions)
    }
}

// MARK: - Copy Button

/// Copy-to-pasteboard button with a 1.5s "Copied" confirmation state. Extracted
/// so both the tool-call row and text overlay share the same confirmation
/// animation and timer-cleanup logic.
private struct SubagentCopyButton: View {
    let text: String

    @State private var showCopyConfirmation = false
    @State private var copyConfirmationTimer: DispatchWorkItem?

    var body: some View {
        ChatEquatableButton(
            label: showCopyConfirmation ? "Copied" : "Copy",
            iconOnly: (showCopyConfirmation ? VIcon.check : VIcon.copy).rawValue,
            iconColorRole: showCopyConfirmation ? .systemPositiveStrong : .contentTertiary
        ) {
            copy()
        }
        .equatable()
        .vTooltip(showCopyConfirmation ? "Copied" : "Copy", edge: .bottom)
        .animation(VAnimation.fast, value: showCopyConfirmation)
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)

        copyConfirmationTimer?.cancel()
        showCopyConfirmation = true
        let timer = DispatchWorkItem { showCopyConfirmation = false }
        copyConfirmationTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: timer)
    }
}

// MARK: - Completed Steps Header

/// Collapsible "Completed N events" header for terminal subagents. Mirrors
/// the main-thread pattern from `AssistantProgressView.swift`.
private struct SubagentCompletedStepsHeader: View {
    let count: Int
    let totalDuration: TimeInterval?
    @Binding var isExpanded: Bool

    var body: some View {
        Button {
            withAnimation(VAnimation.fast) { isExpanded.toggle() }
        } label: {
            HStack(spacing: VSpacing.sm) {
                VIconView(.circleCheck, size: 12)
                    .foregroundStyle(VColor.primaryBase)
                    .frame(width: 16)
                Text("Completed \(count) event\(count == 1 ? "" : "s")")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                Spacer()
                if let totalDuration {
                    Text(VCollapsibleStepRowDurationFormatter.format(totalDuration))
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
                VIconView(isExpanded ? .chevronUp : .chevronDown, size: 9)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.sm, bottom: VSpacing.xs, trailing: VSpacing.sm))
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }
}

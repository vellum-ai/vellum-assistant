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

    /// Usable content width inside VSidePanel's scroll area (panel width
    /// minus `contentPadding`). Measured by a zero-height probe inside the
    /// scroll content closure and forwarded to
    /// `MarkdownSegmentView.maxContentWidth` so markdown wraps to the panel
    /// instead of the default `chatBubbleMaxWidth` (760pt).
    @State private var panelContentWidth: CGFloat = 320
    private static let objectiveMaxHeight: CGFloat = 150

    var body: some View {
        VSidePanel(title: "", titleFont: VFont.titleSmall, onClose: onClose, titleAccessory: {
            panelAvatar
            Text(subagentInfo?.label ?? "Subagent")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)
            statusBadge
        }, headerTrailing: {
            if isRunning {
                Button(action: { onAbort?() }) {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.square, size: 10)
                        Text("Stop")
                            .font(VFont.bodySmallEmphasised)
                    }
                    .foregroundStyle(VColor.systemNegativeStrong)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)
                    .frame(height: 32)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .strokeBorder(VColor.systemNegativeStrong, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .accessibilityLabel("Stop subagent")
            }
        }, pinnedContent: {
            pinnedBody
        }) {
            Color.clear
                .frame(height: 0)
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.size.width
                } action: { newWidth in
                    panelContentWidth = newWidth
                }

            if events.isEmpty, !isRunning {
                VStack(spacing: VSpacing.md) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading events…")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .frame(height: 120)
            } else if events.isEmpty {
                VEmptyState(
                    title: "No events yet",
                    subtitle: "Events will appear as the subagent runs",
                    icon: "waveform.path"
                )
            } else {
                eventList
            }
        }
        .background(VColor.surfaceLift)
        .onAppear {
            // Lazy-load events from DB when the panel opens for a completed subagent with no cached events
            if events.isEmpty, subagentInfo?.conversationId != nil {
                onRequestDetail?()
            }
        }
        .onChange(of: subagentInfo?.conversationId) { _, newConversationId in
            // Safety net: if conversationId becomes available after the panel is
            // already visible (e.g. history reconstruction merges it after .onAppear
            // already fired with conversationId == nil), trigger the lazy-load.
            if events.isEmpty, newConversationId != nil {
                onRequestDetail?()
            }
        }
    }

    // MARK: - Pinned Content

    @ViewBuilder
    private var pinnedBody: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Usage metrics row (above objective per Figma mock)
            if let usage {
                usageMetrics(usage)
            }

            // Objective card
            if let objective, !objective.isEmpty {
                let needsScroll = objective.count > 250
                    || objective.split(separator: "\n", omittingEmptySubsequences: false).count > 5

                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("Objective")
                        .font(VFont.bodyMediumEmphasised)
                        .foregroundStyle(VColor.contentEmphasized)
                    if needsScroll {
                        ScrollView {
                            Text(objective)
                                .font(VFont.bodyMediumLighter)
                                .foregroundStyle(VColor.contentDefault)
                                .lineSpacing(18 - 14)
                        }
                        .frame(height: 120)
                    } else {
                        Text(objective)
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentDefault)
                            .lineSpacing(18 - 14)
                    }
                }
                .padding(EdgeInsets(top: VSpacing.md, leading: VSpacing.md, bottom: VSpacing.lg, trailing: VSpacing.md))
                .vCard(background: VColor.surfaceOverlay)
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
        .padding(.top, VSpacing.lg)
        .padding(.bottom, VSpacing.sm)
    }

    // MARK: - Event List

    /// Groups consecutive tool-call events into a single visual group when the
    /// subagent is terminal. Text / error events render inline in either mode.
    @ViewBuilder
    private var eventList: some View {
        let groups = SubagentEventGrouping.build(events: events)

        VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text("Timeline")
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentEmphasized)

            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(groups.enumerated()), id: \.offset) { index, group in
                    let isLast = index == groups.count - 1
                    timelineNode(for: group, isLast: isLast)
                }
            }
        }
    }

    // MARK: - Timeline Node

    private static let gutterWidth: CGFloat = 24

    private static let iconNodeSize: CGFloat = 24

    @ViewBuilder
    private func timelineNode(for group: SubagentEventGrouping.Group, isLast: Bool) -> some View {
        HStack(alignment: .top, spacing: VSpacing.lg) {
            iconNode(for: group)
                .fixedWidth(Self.gutterWidth)

            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    renderGroup(group)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(.bottom, isLast ? 0 : VSpacing.lg)
        .overlay(alignment: .topLeading) {
            if !isLast {
                Rectangle()
                    .fill(VColor.borderBase)
                    .frame(width: 1.5)
                    .padding(.top, Self.iconNodeSize)
                    .padding(.leading, (Self.gutterWidth - 1.5) / 2)
            }
        }
    }

    @ViewBuilder
    private func iconNode(for group: SubagentEventGrouping.Group) -> some View {
        VIconView(timelineIcon(for: group), size: 12)
            .foregroundStyle(timelineIconColor(for: group))
            .padding(6)
            .background(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .fill(timelineIconBackground(for: group))
            )
    }

    private func timelineIcon(for group: SubagentEventGrouping.Group) -> VIcon {
        if group.isError { return .triangleAlert }
        switch group {
        case .text: return .messageSquare
        case .error: return .triangleAlert
        case .toolCall: return .wrench
        case .orphanToolResult: return .circleCheck
        case .completedToolCalls: return .circleCheck
        }
    }

    private func timelineIconColor(for group: SubagentEventGrouping.Group) -> Color {
        if group.isError { return VColor.systemNegativeStrong }
        return VColor.systemPositiveStrong
    }

    private func timelineIconBackground(for group: SubagentEventGrouping.Group) -> Color {
        if group.isError { return VColor.systemNegativeStrong.opacity(0.12) }
        return VColor.systemPositiveWeak
    }

    // MARK: - Group Rendering

    @ViewBuilder
    private func renderGroup(_ group: SubagentEventGrouping.Group) -> some View {
        switch group {
        case .text(let event):
            timelineCard(title: "Response") {
                textCardContent(event)
            }
        case .error(let event):
            timelineCard(title: "Error") {
                errorCardContent(event)
            }
        case .toolCall(let pair):
            timelineCard(title: "Tool Call") {
                toolCallCardContent(pair)
            }
        case .orphanToolResult(let event):
            timelineCard(title: "Tool Result") {
                toolResultCardContent(event)
            }
        case .completedToolCalls:
            EmptyView()
        }
    }

    // MARK: - Timeline Card

    @ViewBuilder
    private func timelineCard<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text(title)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentEmphasized)
                content()
            }
            Spacer(minLength: 0)
        }
        .padding(EdgeInsets(top: VSpacing.md, leading: VSpacing.md, bottom: VSpacing.lg, trailing: VSpacing.md))
        .vCard(background: VColor.surfaceOverlay)
    }

    // MARK: - Card Content Views

    @ViewBuilder
    private func textCardContent(_ event: SubagentEventItem) -> some View {
        ZStack(alignment: .topTrailing) {
            Text(event.content)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .lineSpacing(18 - 14)
                .textSelection(.enabled)

            SubagentTextActionOverlay(
                event: event,
                showInspectButton: showInspectButton,
                onInspectMessage: onInspectMessage
            )
        }
    }

    @ViewBuilder
    private func errorCardContent(_ event: SubagentEventItem) -> some View {
        Text(event.content)
            .font(VFont.bodyMediumLighter)
            .foregroundStyle(VColor.systemNegativeStrong)
            .textSelection(.enabled)
    }

    @ViewBuilder
    private func toolCallCardContent(_ pair: SubagentToolCallPair) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(pair.toolName)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentTertiary)
            if !pair.inputSummary.isEmpty {
                Text(pair.inputSummary)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentSecondary)
            }
            if let resultContent = pair.resultContent, !resultContent.isEmpty {
                Divider().background(VColor.borderBase)
                if pair.resultIsError {
                    Text(resultContent)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.systemNegativeStrong)
                        .textSelection(.enabled)
                } else {
                    SubagentCollapsibleText(
                        text: resultContent,
                        isExpanded: Binding(
                            get: { state?.isEventExpanded(pair.id) ?? false },
                            set: { state?.setEventExpanded(pair.id, expanded: $0) }
                        )
                    )
                }
            }
        }
    }

    @ViewBuilder
    private func toolResultCardContent(_ event: SubagentEventItem) -> some View {
        if !event.content.isEmpty {
            SubagentCollapsibleText(
                text: event.content,
                isExpanded: Binding(
                    get: { state?.isEventExpanded(event.id) ?? false },
                    set: { state?.setEventExpanded(event.id, expanded: $0) }
                )
            )
        }
    }

    // MARK: - Status Badge

    @ViewBuilder
    private var panelAvatar: some View {
        VAvatarImage(
            image: SubagentAvatarProvider.avatar(for: subagentId, size: 28),
            size: 23,
            showBorder: false
        )
    }

    @ViewBuilder
    private var statusBadge: some View {
        if let info = subagentInfo {
            Text(info.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(statusTextColor(info.status))
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xs)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .fill(statusBackgroundColor(info.status))
                )
        }
    }

    private func statusTextColor(_ status: SubagentStatus) -> Color {
        switch status {
        case .completed: return VColor.contentDefault
        case .failed, .aborted: return VColor.systemNegativeStrong
        case .running: return VColor.primaryActive
        default: return VColor.contentTertiary
        }
    }

    private func statusBackgroundColor(_ status: SubagentStatus) -> Color {
        switch status {
        case .completed: return VColor.systemPositiveWeak
        case .failed, .aborted: return VColor.systemNegativeStrong.opacity(0.12)
        case .running: return VColor.primaryActive.opacity(0.12)
        default: return VColor.contentTertiary.opacity(0.12)
        }
    }

    // MARK: - Usage Metrics

    @ViewBuilder
    private func usageMetrics(_ usage: SubagentUsageStats) -> some View {
        HStack(spacing: VSpacing.sm) {
            metricCard(icon: .arrowDown, label: "Input", value: formatNumber(usage.inputTokens))
            metricCard(icon: .arrowUp, label: "Output", value: formatNumber(usage.outputTokens))
            metricCard(icon: .circleDollarSign, label: "Cost", value: formatCost(usage.estimatedCost))
        }
    }

    @ViewBuilder
    private func metricCard(icon: VIcon, label: String, value: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(icon, size: 16)
                .foregroundStyle(VColor.contentTertiary)
                .padding(VSpacing.sm)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(VColor.primaryDisabled)
                )
            VStack(alignment: .leading, spacing: 0) {
                Text(value)
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .contentTransition(.numericText())
                    .animation(.easeInOut(duration: 0.3), value: value)
                Text(label)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            Spacer(minLength: 0)
        }
        .padding(VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .strokeBorder(VColor.borderBase, lineWidth: 1)
        )
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

        var isError: Bool {
            switch self {
            case .error: return true
            case .toolCall(let pair): return pair.resultIsError
            case .orphanToolResult(let event):
                if case .toolResult(let isErr) = event.kind { return isErr }
                return false
            default: return false
            }
        }
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


// MARK: - Collapsible Text

private struct SubagentCollapsibleText: View {
    let text: String
    @Binding var isExpanded: Bool
    private let collapsedLineLimit = 4

    private var likelyTruncated: Bool {
        text.split(separator: "\n", omittingEmptySubsequences: false).count > collapsedLineLimit
            || text.count > 300
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text(text)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(isExpanded ? nil : collapsedLineLimit)
                .textSelection(.enabled)

            if likelyTruncated || isExpanded {
                Button {
                    withAnimation(VAnimation.fast) { isExpanded.toggle() }
                } label: {
                    Text(isExpanded ? "Show less" : "Show more")
                        .font(VFont.bodySmallEmphasised)
                        .foregroundStyle(VColor.primaryBase)
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }
        }
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


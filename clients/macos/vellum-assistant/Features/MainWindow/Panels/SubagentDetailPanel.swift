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
                            .lineLimit(4)
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
                LazyVStack(alignment: .leading, spacing: VSpacing.lg) {
                    ForEach(events) { event in
                        SubagentEventRowView(
                            event: event,
                            showInspectButton: showInspectButton,
                            onInspectMessage: onInspectMessage,
                            typographyGeneration: typographyObserver.generation
                        )
                    }
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

// MARK: - Event Row View

/// Each event row needs its own hover/copy-confirmation state, so it must be a
/// separate view struct (SwiftUI scopes @State per view identity in ForEach).
private struct SubagentEventRowView: View {
    let event: SubagentEventItem
    let showInspectButton: Bool
    var onInspectMessage: ((String) -> Void)?
    let typographyGeneration: Int

    @State private var isHovered = false
    @State private var showCopyConfirmation = false
    @State private var copyConfirmationTimer: DispatchWorkItem?

    private var hasCopyableContent: Bool {
        !event.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canInspect: Bool {
        showInspectButton && event.daemonMessageId != nil && {
            if case .text = event.kind { return true }
            return false
        }()
    }

    private var showActions: Bool {
        (hasCopyableContent || canInspect) && (isHovered || showCopyConfirmation)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            eventLabel(for: event.kind)

            ZStack(alignment: .topTrailing) {
                eventContent(event)

                if showActions {
                    actionButtons
                        .transition(.opacity)
                }
            }
            .onHover { isHovered = $0 }
            .animation(VAnimation.fast, value: showActions)
        }
    }

    // MARK: - Action Buttons

    private var actionButtons: some View {
        HStack(spacing: 2) {
            if hasCopyableContent {
                ChatEquatableButton(
                    label: showCopyConfirmation ? "Copied" : "Copy",
                    iconOnly: (showCopyConfirmation ? VIcon.check : VIcon.copy).rawValue,
                    iconColorRole: showCopyConfirmation ? .systemPositiveStrong : .contentTertiary
                ) {
                    copyContent()
                }
                .equatable()
                .vTooltip(showCopyConfirmation ? "Copied" : "Copy", edge: .bottom)
                .animation(VAnimation.fast, value: showCopyConfirmation)
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
    }

    // MARK: - Copy

    private func copyContent() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(event.content, forType: .string)

        copyConfirmationTimer?.cancel()
        showCopyConfirmation = true
        let timer = DispatchWorkItem { showCopyConfirmation = false }
        copyConfirmationTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: timer)
    }

    // MARK: - Event Label

    @ViewBuilder
    private func eventLabel(for kind: SubagentEventItem.Kind) -> some View {
        switch kind {
        case .text:
            label(icon: "text.bubble.fill", text: "RESPONSE", color: VColor.systemPositiveStrong)
        case .toolUse:
            label(icon: "wrench.fill", text: "TOOL CALL", color: VColor.systemPositiveStrong)
        case .toolResult(let isError):
            label(icon: isError ? "xmark.circle.fill" : "checkmark.circle.fill", text: isError ? "TOOL ERROR" : "TOOL RESULT", color: isError ? VColor.systemNegativeStrong : VColor.systemPositiveStrong)
        case .error:
            label(icon: "exclamationmark.triangle.fill", text: "ERROR", color: VColor.systemNegativeStrong)
        }
    }

    @ViewBuilder
    private func label(icon: String, text: String, color: Color) -> some View {
        HStack(spacing: VSpacing.xxs) {
            VIconView(SFSymbolMapping.icon(forSFSymbol: icon, fallback: .puzzle), size: 8)
            Text(text)
                .font(VFont.labelSmall)
        }
        .foregroundStyle(color)
    }

    // MARK: - Event Content

    @ViewBuilder
    private func eventContent(_ event: SubagentEventItem) -> some View {
        switch event.kind {
        case .text:
            MarkdownSegmentView(
                segments: parseMarkdownSegments(event.content),
                typographyGeneration: typographyGeneration,
                maxContentWidth: nil
            )
                .equatable()
                .textSelection(.enabled)
                .padding(VSpacing.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(VColor.surfaceBase.opacity(0.4))
                )

        case .toolUse(let name):
            HStack(spacing: VSpacing.xs) {
                Text(name)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemPositiveStrong)
                if !event.content.isEmpty {
                    Text(event.content)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .padding(VSpacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(VColor.primaryActive.opacity(0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .strokeBorder(VColor.primaryActive.opacity(0.16), lineWidth: 1)
                    )
            )

        case .toolResult:
            Text(event.content)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
                .lineLimit(6)
                .textSelection(.enabled)
                .padding(VSpacing.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(VColor.surfaceActive.opacity(0.3))
                )

        case .error:
            Text(event.content)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.systemNegativeStrong)
                .textSelection(.enabled)
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
    }
}

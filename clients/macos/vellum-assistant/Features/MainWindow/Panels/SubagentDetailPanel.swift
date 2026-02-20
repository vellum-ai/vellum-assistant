import SwiftUI
import VellumAssistantShared

struct SubagentDetailPanel: View {
    let subagentId: String
    @ObservedObject var viewModel: ChatViewModel
    @ObservedObject var detailStore: SubagentDetailStore
    var onAbort: (() -> Void)?
    var onRequestDetail: (() -> Void)?
    var onClose: () -> Void

    private var subagentInfo: SubagentInfo? { viewModel.activeSubagents.first(where: { $0.id == subagentId }) }
    private var objective: String? { detailStore.objectives[subagentId] }
    private var usage: SubagentUsageStats? { detailStore.usageStats[subagentId] }
    private var events: [SubagentEventItem] { detailStore.eventsBySubagent[subagentId] ?? [] }
    private var isRunning: Bool { subagentInfo?.status == .running || subagentInfo?.status == .pending }

    var body: some View {
        VSidePanel(title: subagentInfo?.label ?? "Subagent", titleFont: VFont.sectionTitle, onClose: onClose, pinnedContent: {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                // Status + abort row
                HStack {
                    statusBadge
                    Spacer()
                    if isRunning {
                        Button(action: { onAbort?() }) {
                            HStack(spacing: VSpacing.xxs) {
                                Image(systemName: "stop.fill")
                                    .font(.system(size: 8))
                                Text("Abort")
                                    .font(VFont.captionMedium)
                            }
                            .foregroundColor(Rose._400)
                            .padding(.horizontal, VSpacing.sm)
                            .padding(.vertical, VSpacing.xxs)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.pill)
                                    .fill(Rose._500.opacity(0.12))
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
                            .font(VFont.small)
                            .foregroundColor(VColor.textMuted)
                        Text(objective)
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
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
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 11))
                            .foregroundColor(Rose._500)
                        Text(error)
                            .font(VFont.caption)
                            .foregroundColor(Rose._400)
                    }
                    .padding(VSpacing.sm)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .fill(Rose._500.opacity(0.08))
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.md)
                                    .strokeBorder(Rose._500.opacity(0.2), lineWidth: 1)
                            )
                    )
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.lg)

            Divider().background(VColor.surfaceBorder)
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
                        eventRow(event)
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
                    .font(VFont.captionMedium)
                    .foregroundColor(statusColor(info.status))
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
        case .completed: return Emerald._500
        case .failed, .aborted: return Rose._500
        case .running: return Violet._500
        default: return Slate._400
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
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundColor(VColor.textMuted)
            VStack(alignment: .leading, spacing: 0) {
                Text(label)
                    .font(VFont.small)
                    .foregroundColor(VColor.textMuted)
                Text(value)
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.textSecondary)
            }
        }
    }

    // MARK: - Event Row

    @ViewBuilder
    private func eventRow(_ event: SubagentEventItem) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            // Label above the card
            eventLabel(for: event.kind)

            // Content card
            eventContent(event)
        }
    }

    @ViewBuilder
    private func eventLabel(for kind: SubagentEventItem.Kind) -> some View {
        switch kind {
        case .text:
            label(icon: "text.bubble.fill", text: "RESPONSE", color: Indigo._400)
        case .toolUse:
            label(icon: "wrench.fill", text: "TOOL CALL", color: Violet._400)
        case .toolResult(let isError):
            label(icon: isError ? "xmark.circle.fill" : "checkmark.circle.fill", text: isError ? "TOOL ERROR" : "TOOL RESULT", color: isError ? Rose._400 : Emerald._400)
        case .error:
            label(icon: "exclamationmark.triangle.fill", text: "ERROR", color: Rose._500)
        }
    }

    @ViewBuilder
    private func label(icon: String, text: String, color: Color) -> some View {
        HStack(spacing: VSpacing.xxs) {
            Image(systemName: icon)
                .font(.system(size: 8))
            Text(text)
                .font(VFont.small)
        }
        .foregroundColor(color)
    }

    @ViewBuilder
    private func eventContent(_ event: SubagentEventItem) -> some View {
        switch event.kind {
        case .text:
            MarkdownSegmentView(segments: parseMarkdownSegments(event.content), maxContentWidth: nil)
                .padding(VSpacing.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(VColor.surface.opacity(0.4))
                )

        case .toolUse(let name):
            HStack(spacing: VSpacing.xs) {
                Text(name)
                    .font(VFont.captionMedium)
                    .foregroundColor(Violet._300)
                if !event.content.isEmpty {
                    Text(event.content)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .padding(VSpacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(Violet._500.opacity(0.06))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .strokeBorder(Violet._500.opacity(0.12), lineWidth: 1)
                    )
            )

        case .toolResult:
            Text(event.content)
                .font(VFont.monoSmall)
                .foregroundColor(VColor.textSecondary)
                .lineLimit(6)
                .textSelection(.enabled)
                .padding(VSpacing.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(VColor.surface.opacity(0.3))
                )

        case .error:
            Text(event.content)
                .font(VFont.caption)
                .foregroundColor(Rose._400)
                .textSelection(.enabled)
                .padding(VSpacing.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(Rose._500.opacity(0.08))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .strokeBorder(Rose._500.opacity(0.15), lineWidth: 1)
                        )
                )
        }
    }

    // MARK: - Formatting

    private func formatNumber(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fK", Double(n) / 1_000) }
        return "\(n)"
    }

    private func formatCost(_ cost: Double) -> String {
        if cost == 0 { return "$0.00" }
        if cost < 0.01 { return "<$0.01" }
        return String(format: "$%.2f", cost)
    }
}

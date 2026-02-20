import SwiftUI
import VellumAssistantShared

struct SubagentDetailPanel: View {
    let subagentId: String
    @ObservedObject var viewModel: ChatViewModel
    var onClose: () -> Void

    private var detailStore: SubagentDetailStore { viewModel.subagentDetailStore }
    private var subagentInfo: SubagentInfo? { viewModel.activeSubagents.first(where: { $0.id == subagentId }) }
    private var objective: String? { detailStore.objectives[subagentId] }
    private var usage: SubagentUsageStats? { detailStore.usageStats[subagentId] }
    private var events: [SubagentEventItem] { detailStore.eventsBySubagent[subagentId] ?? [] }

    var body: some View {
        VSidePanel(title: subagentInfo?.label ?? "Subagent", onClose: onClose, pinnedContent: {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                // Status badge
                if let info = subagentInfo {
                    statusBadge(info)
                }

                // Objective
                if let objective, !objective.isEmpty {
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text("Objective")
                            .font(VFont.captionMedium)
                            .foregroundColor(VColor.textMuted)
                        Text(objective)
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                            .lineLimit(4)
                    }
                }

                // Usage metrics
                if let usage {
                    usageMetrics(usage)
                }

                // Error
                if let error = subagentInfo?.error, !error.isEmpty {
                    Text(error)
                        .font(VFont.caption)
                        .foregroundColor(Rose._400)
                        .padding(VSpacing.xs)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.sm)
                                .fill(Rose._500.opacity(0.1))
                        )
                }
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)

            Divider().background(VColor.surfaceBorder)
        }) {
            if events.isEmpty {
                VEmptyState(
                    title: "No events yet",
                    subtitle: "Events will appear as the subagent runs",
                    icon: "waveform.path"
                )
            } else {
                LazyVStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(events) { event in
                        eventRow(event)
                    }
                }
                .padding(.horizontal, VSpacing.sm)
            }
        }
    }

    // MARK: - Status Badge

    @ViewBuilder
    private func statusBadge(_ info: SubagentInfo) -> some View {
        HStack(spacing: VSpacing.xs) {
            Circle()
                .fill(statusColor(info.status))
                .frame(width: 8, height: 8)
            Text(info.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textSecondary)
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
        HStack(spacing: VSpacing.lg) {
            metricItem(icon: "arrow.down.circle", label: "Input", value: "\(formatNumber(usage.inputTokens)) tokens")
            metricItem(icon: "arrow.up.circle", label: "Output", value: "\(formatNumber(usage.outputTokens)) tokens")
            metricItem(icon: "dollarsign.circle", label: "Cost", value: formatCost(usage.estimatedCost))
        }
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
        switch event.kind {
        case .text:
            Text(event.content)
                .font(VFont.mono)
                .foregroundColor(VColor.textPrimary)
                .textSelection(.enabled)
                .padding(VSpacing.xs)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .fill(VColor.backgroundSubtle.opacity(0.3))
                )

        case .toolUse(let name):
            HStack(spacing: VSpacing.xs) {
                Image(systemName: "wrench.fill")
                    .font(.system(size: 10))
                    .foregroundColor(Violet._400)
                Text(name)
                    .font(VFont.captionMedium)
                    .foregroundColor(Violet._400)
                if !event.content.isEmpty {
                    Text(event.content)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .padding(VSpacing.xs)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .fill(Violet._500.opacity(0.08))
            )

        case .toolResult(let isError):
            HStack(alignment: .top, spacing: VSpacing.xs) {
                Image(systemName: isError ? "xmark.circle.fill" : "checkmark.circle.fill")
                    .font(.system(size: 10))
                    .foregroundColor(isError ? Rose._400 : Emerald._400)
                Text(event.content)
                    .font(VFont.monoSmall)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(6)
                    .textSelection(.enabled)
            }
            .padding(VSpacing.xs)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .fill(VColor.backgroundSubtle.opacity(0.2))
            )

        case .error:
            HStack(alignment: .top, spacing: VSpacing.xs) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 10))
                    .foregroundColor(Rose._500)
                Text(event.content)
                    .font(VFont.caption)
                    .foregroundColor(Rose._400)
                    .textSelection(.enabled)
            }
            .padding(VSpacing.xs)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .fill(Rose._500.opacity(0.1))
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

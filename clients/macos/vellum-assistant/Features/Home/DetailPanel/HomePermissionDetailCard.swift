import SwiftUI
import VellumAssistantShared

/// Body component for tool-permission detail panels.
///
/// Renders structured permission fields (tool name, command preview, risk
/// level, decision) from `ToolPermissionPanelData` as a compact details
/// card. Falls back to the feed item's title when no structured data is
/// available.
struct HomePermissionDetailCard: View {
    let item: FeedItem

    private var panelData: ToolPermissionPanelData? {
        ToolPermissionPanelData.from(item.detailPanel?.data)
    }

    var body: some View {
        if let data = panelData {
            structuredContent(data)
        } else {
            Text(item.title)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
    }

    // MARK: - Structured Content

    @ViewBuilder
    private func structuredContent(_ data: ToolPermissionPanelData) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            if let decision = data.decision {
                decisionBadge(decision)
            }

            detailsCard(data)
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    @ViewBuilder
    private func decisionBadge(_ decision: String) -> some View {
        let isApproved = decision.lowercased().contains("allow") || decision.lowercased().contains("approve")
        HStack(spacing: VSpacing.xs) {
            VIconView(isApproved ? .check : .x, size: 14)
            Text(decision.capitalized)
                .font(VFont.bodyMediumEmphasised)
        }
        .foregroundStyle(isApproved ? VColor.systemPositiveStrong : VColor.systemNegativeStrong)
    }

    private func detailsCard(_ data: ToolPermissionPanelData) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Details")
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentEmphasized)
                .accessibilityAddTraits(.isHeader)

            detailRow(key: "Tool", value: data.toolName)

            if let command = data.commandPreview {
                detailRow(key: "Command", value: command)
            }

            if let risk = data.riskLevel {
                HStack {
                    Text("Risk")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentTertiary)
                    Spacer()
                    Text(risk.capitalized)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(riskColor(for: risk))
                }
            }
        }
        .padding(EdgeInsets(
            top: VSpacing.md,
            leading: VSpacing.md,
            bottom: VSpacing.lg,
            trailing: VSpacing.md
        ))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg, style: .continuous)
                .fill(VColor.surfaceOverlay)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg, style: .continuous)
                .strokeBorder(VColor.borderHover, lineWidth: 1)
        )
    }

    private func detailRow(key: String, value: String) -> some View {
        HStack {
            Text(key)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentTertiary)
            Spacer()
            Text(value)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(2)
                .multilineTextAlignment(.trailing)
        }
    }

    private func riskColor(for level: String) -> Color {
        switch level.lowercased() {
        case "high":   return VColor.systemNegativeStrong
        case "medium": return VColor.systemMidStrong
        default:       return VColor.contentDefault
        }
    }
}

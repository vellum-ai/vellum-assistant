import SwiftUI
import VellumAssistantShared

struct MessageInspectorOverviewTab: View {
    let entry: LLMRequestLogEntry

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                if let summary = entry.summary {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Available summary data")
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.contentDefault)

                        if let title = summary.title, !title.isEmpty {
                            summaryRow(label: "Title", value: title)
                        }
                        if let provider = summary.provider, !provider.isEmpty {
                            summaryRow(label: "Provider", value: provider)
                        }
                        if let model = summary.model, !model.isEmpty {
                            summaryRow(label: "Model", value: model)
                        }
                        if let status = summary.status, !status.isEmpty {
                            summaryRow(label: "Status", value: status)
                        }
                    }
                    .padding(VSpacing.lg)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(VColor.surfaceOverlay)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                }

                VEmptyState(
                    title: "Overview data unavailable yet",
                    subtitle: "This tab is wired up, but richer per-call overview content lands in a follow-up PR.",
                    icon: VIcon.layoutGrid.rawValue
                )
                .frame(minHeight: 280)
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(VColor.surfaceBase)
    }

    private func summaryRow(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.contentSecondary)

            Text(value)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .textSelection(.enabled)
        }
    }
}

import SwiftUI
import VellumAssistantShared

struct MessageInspectorOverviewTab: View {
    let entry: LLMRequestLogEntry

    private var content: MessageInspectorOverviewContent {
        MessageInspectorOverviewContent(entry: entry)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                if let fallbackMessage = content.fallbackMessage {
                    fallbackCard(message: fallbackMessage)
                } else {
                    metadataCard(
                        title: "Normalized metadata",
                        subtitle: "Provider, model, timestamps, and usage counts.",
                        rows: content.identityRows
                    )

                    metadataCard(
                        title: "Usage",
                        subtitle: "Token and call counts normalized by the assistant route.",
                        rows: content.usageRows
                    )

                    secondaryCard(
                        title: "Response preview",
                        body: content.responsePreview ?? MessageInspectorSummaryFormatters.missingValue
                    )

                    secondaryCard(
                        title: "Tool calls",
                        body: content.toolCallNames ?? MessageInspectorSummaryFormatters.missingValue
                    )
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(VColor.surfaceBase)
    }

    private func metadataCard(title: String, subtitle: String, rows: [MessageInspectorOverviewContent.Row]) -> some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                cardHeader(title: title, subtitle: subtitle)

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    ForEach(rows) { row in
                        metadataRow(row)
                    }
                }
            }
        }
    }

    private func secondaryCard(title: String, body: String) -> some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                cardHeader(title: title, subtitle: nil)

                Text(body)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
    }

    private func fallbackCard(message: String) -> some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                cardHeader(
                    title: "Normalized summary unavailable",
                    subtitle: "This call still has raw request and response payloads."
                )

                Text(message)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
    }

    private func cardHeader(title: String, subtitle: String?) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(title)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)

            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    private func metadataRow(_ row: MessageInspectorOverviewContent.Row) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: VSpacing.md) {
            Text(row.label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)

            Spacer(minLength: VSpacing.sm)

            Text(row.value)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }
}

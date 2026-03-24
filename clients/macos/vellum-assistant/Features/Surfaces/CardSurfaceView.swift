import VellumAssistantShared
import SwiftUI

struct CardSurfaceView: View {
    let data: CardSurfaceData

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text(data.title)
                .font(VFont.titleSmall)
                .foregroundColor(VColor.contentDefault)

            if let subtitle = data.subtitle {
                Text(subtitle)
                    .font(VFont.labelDefault)
                    .foregroundColor(VColor.contentSecondary)
            }

            Text(.init(data.body))
                .font(VFont.bodyMediumLighter)
                .foregroundColor(VColor.contentSecondary)

            if let metadata = data.metadata, !metadata.isEmpty {
                metadataGrid(metadata)
            }
        }
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func metadataGrid(_ metadata: [(label: String, value: String)]) -> some View {
        LazyVGrid(columns: [
            GridItem(.flexible(), alignment: .leading),
            GridItem(.flexible(), alignment: .leading)
        ], alignment: .leading, spacing: VSpacing.md) {
            ForEach(Array(metadata.enumerated()), id: \.offset) { _, item in
                Text(item.label)
                    .font(VFont.labelDefault)
                    .foregroundColor(VColor.contentTertiary)
                Text(item.value)
                    .font(VFont.labelDefault)
                    .foregroundColor(VColor.contentSecondary)
            }
        }
        .padding(VSpacing.lg)
        .vCard()
        .textSelection(.enabled)
    }
}

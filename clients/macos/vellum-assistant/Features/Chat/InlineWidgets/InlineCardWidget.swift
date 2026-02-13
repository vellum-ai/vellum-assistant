import SwiftUI

/// Inline card widget for displaying structured information in chat.
struct InlineCardWidget: View {
    let data: CardSurfaceData

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Title + subtitle
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(data.title)
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)

                if let subtitle = data.subtitle {
                    Text(subtitle)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            }

            // Body text
            Text(markdownBody)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .textSelection(.enabled)

            // Metadata grid
            if let metadata = data.metadata, !metadata.isEmpty {
                metadataGrid(metadata)
            }
        }
    }

    private func metadataGrid(_ metadata: [(label: String, value: String)]) -> some View {
        let columns = [
            GridItem(.flexible(), spacing: VSpacing.md),
            GridItem(.flexible(), spacing: VSpacing.md),
        ]
        return LazyVGrid(columns: columns, alignment: .leading, spacing: VSpacing.sm) {
            ForEach(Array(metadata.enumerated()), id: \.offset) { _, item in
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text(item.label)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    Text(item.value)
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.textPrimary)
                }
            }
        }
        .padding(VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.backgroundSubtle.opacity(0.5))
        )
    }

    private var markdownBody: AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: data.body, options: options))
            ?? AttributedString(data.body)
    }
}

#if DEBUG
#Preview("InlineCardWidget") {
    ZStack {
        VColor.background.ignoresSafeArea()
        InlineCardWidget(data: CardSurfaceData(
            title: "Weather in New York",
            subtitle: "Next 7 days",
            body: "Partly cloudy with temperatures ranging from 45°F to 62°F. Rain expected on Wednesday.",
            metadata: [
                (label: "High", value: "62°F"),
                (label: "Low", value: "45°F"),
                (label: "Humidity", value: "65%"),
                (label: "Wind", value: "12 mph NW"),
            ]
        ))
        .padding()
    }
    .frame(width: 400, height: 300)
}
#endif

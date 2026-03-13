import SwiftUI

/// Inline card widget for displaying structured information in chat.
/// Supports template-based rendering for specialized layouts (e.g. weather forecasts).
public struct InlineCardWidget: View {
    public let data: CardSurfaceData

    public init(data: CardSurfaceData) {
        self.data = data
    }

    public var body: some View {
        if data.template == "weather_forecast",
           let templateData = data.templateData,
           let weatherData = WeatherForecastData.parse(from: templateData) {
            InlineWeatherWidget(data: weatherData)
        } else if data.template == "task_progress",
                  let templateData = data.templateData,
                  let progressData = TaskProgressData.parse(from: templateData, fallbackTitle: data.title) {
            InlineTaskProgressWidget(data: progressData)
        } else {
            standardCardLayout
        }
    }

    private var standardCardLayout: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Title + subtitle
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(data.title)
                    .font(VFont.headline)
                    .foregroundColor(VColor.contentDefault)

                if let subtitle = data.subtitle {
                    Text(subtitle)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                }
            }

            // Body text
            if !data.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(markdownBody)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                    .textSelection(.enabled)
            }

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
                        .foregroundColor(VColor.contentTertiary)
                    Text(item.value)
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.contentDefault)
                }
            }
        }
        .padding(VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceBase.opacity(0.5))
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
#endif

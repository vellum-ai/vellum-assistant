import SwiftUI

/// Compact preview card for dynamic pages shown inline in chat.
/// Displays icon, title, subtitle, description, metric pills, and a "View Output" button.
public struct InlineDynamicPagePreview: View {
    public let preview: DynamicPagePreview
    public let onViewOutput: () -> Void

    public init(preview: DynamicPagePreview, onViewOutput: @escaping () -> Void) {
        self.preview = preview
        self.onViewOutput = onViewOutput
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Icon + Title + Subtitle
            HStack(alignment: .top, spacing: VSpacing.sm) {
                if let icon = preview.icon {
                    Text(icon)
                        .font(.system(size: 24))
                }

                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text(preview.title)
                        .font(VFont.headline)
                        .foregroundColor(VColor.textPrimary)
                        .lineLimit(2)

                    if let subtitle = preview.subtitle {
                        Text(subtitle)
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                            .lineLimit(1)
                    }
                }
            }

            // Description
            if let description = preview.description, !description.isEmpty {
                Text(description)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(3)
            }

            // Metric pills (max 3)
            if let metrics = preview.metrics, !metrics.isEmpty {
                HStack(spacing: VSpacing.sm) {
                    ForEach(Array(metrics.prefix(3).enumerated()), id: \.offset) { _, metric in
                        metricPill(label: metric.label, value: metric.value)
                    }
                }
            }

            // View Output button
            HStack {
                Spacer()
                Button {
                    onViewOutput()
                } label: {
                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: "arrow.up.right.square")
                            .font(VFont.caption)
                        Text("View Output")
                            .font(VFont.bodyMedium)
                    }
                    .foregroundColor(.white)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.sm)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .fill(VColor.accent)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("View Output")
            }
        }
        .frame(maxWidth: 350)
    }

    private func metricPill(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(label)
                .font(VFont.small)
                .foregroundColor(VColor.textMuted)
            Text(value)
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textPrimary)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(VColor.backgroundSubtle.opacity(0.5))
        )
    }
}

#if DEBUG
#Preview("InlineDynamicPagePreview") {
    ZStack {
        VColor.background.ignoresSafeArea()
        InlineDynamicPagePreview(
            preview: DynamicPagePreview(
                title: "Expense Tracker",
                subtitle: "Personal Finance App",
                description: "Track your daily expenses with category breakdowns and monthly summaries.",
                icon: "\u{1F4B0}",
                metrics: [
                    (label: "Records", value: "24"),
                    (label: "Categories", value: "8"),
                    (label: "Total", value: "$1,234"),
                ]
            ),
            onViewOutput: {}
        )
        .padding()
    }
    .frame(width: 400, height: 300)
}
#endif

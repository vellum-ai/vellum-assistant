import SwiftUI

/// Compact preview card for dynamic pages shown inline in chat.
/// The entire card is clickable to open the workspace panel.
public struct InlineDynamicPagePreview: View {
    public let preview: DynamicPagePreview
    public let onViewOutput: () -> Void

    @State private var isHovered: Bool = false

    public init(preview: DynamicPagePreview, onViewOutput: @escaping () -> Void) {
        self.preview = preview
        self.onViewOutput = onViewOutput
    }

    public var body: some View {
        Button {
            onViewOutput()
        } label: {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    if let icon = preview.icon {
                        Text(icon)
                            .font(.system(size: 24))
                    }

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

                if let description = preview.description, !description.isEmpty {
                    Text(description)
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                        .lineLimit(3)
                }

                if let metrics = preview.metrics, !metrics.isEmpty {
                    HStack(spacing: VSpacing.sm) {
                        ForEach(Array(metrics.prefix(3).enumerated()), id: \.offset) { _, metric in
                            metricPill(label: metric.label, value: metric.value)
                        }
                    }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(maxWidth: 350)
        .onHover { hovering in
            #if os(macOS)
            if hovering { NSCursor.pointingHand.set() }
            else { NSCursor.arrow.set() }
            #endif
            isHovered = hovering
        }
        .scaleEffect(isHovered ? 1.015 : 1.0)
        .animation(.easeInOut(duration: 0.15), value: isHovered)
        .accessibilityLabel("View output: \(preview.title)")
        .accessibilityAddTraits(.isButton)
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

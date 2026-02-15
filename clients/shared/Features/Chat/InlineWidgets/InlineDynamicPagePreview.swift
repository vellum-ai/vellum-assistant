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
            .overlay(alignment: .topTrailing) {
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(isHovered ? VColor.textPrimary : VColor.textSecondary)
                    .padding(VSpacing.xs)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.sm)
                            .fill(VColor.surfaceBorder.opacity(isHovered ? 0.6 : 0.3))
                    )
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

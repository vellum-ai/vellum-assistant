import SwiftUI

/// Compact preview card for dynamic pages shown inline in chat.
/// The entire card is clickable to open the workspace panel.
/// While the parent message is still streaming (`isBuilding`), the card shows
/// a reduced-opacity disabled state with no interaction.
public struct InlineDynamicPagePreview: View {
    public let preview: DynamicPagePreview
    /// When true, the assistant is still working — show a visually disabled state.
    public let isBuilding: Bool
    public let onViewOutput: () -> Void

    public init(preview: DynamicPagePreview, isBuilding: Bool = false, onViewOutput: @escaping () -> Void) {
        self.preview = preview
        self.isBuilding = isBuilding
        self.onViewOutput = onViewOutput
    }

    public var body: some View {
        Button {
            guard !isBuilding else { return }
            onViewOutput()
        } label: {
            VStack(alignment: .leading, spacing: VSpacing.xl) {
                // Icon + title row
                HStack(spacing: VSpacing.sm) {
                    if let icon = preview.icon {
                        if let url = URL(string: icon), url.scheme == "https" || url.scheme == "http" {
                            AsyncImage(url: url) { phase in
                                switch phase {
                                case .success(let image):
                                    image
                                        .resizable()
                                        .aspectRatio(contentMode: .fit)
                                case .failure:
                                    RoundedRectangle(cornerRadius: VRadius.sm)
                                        .fill(VColor.surfaceOverlay)
                                default:
                                    RoundedRectangle(cornerRadius: VRadius.sm)
                                        .fill(VColor.surfaceOverlay)
                                }
                            }
                            .frame(width: 32, height: 32)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        } else {
                            Text(icon)
                                .font(.system(size: 28))
                        }
                    }

                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text(preview.title)
                            .font(VFont.bodyMediumEmphasised)
                            .foregroundStyle(VColor.contentDefault)
                            .lineLimit(2)

                        if let subtitle = preview.subtitle {
                            Text(subtitle)
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentTertiary)
                                .lineLimit(1)
                        }
                    }
                }

                if let description = preview.description, !description.isEmpty {
                    Text(description)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
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
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(isBuilding ? 0.5 : 1.0)
        .allowsHitTesting(!isBuilding)
        .animation(VAnimation.fast, value: isBuilding)
        .accessibilityLabel(isBuilding ? "Building: \(preview.title)" : "View output: \(preview.title)")
        .accessibilityAddTraits(.isButton)
    }

    private func metricPill(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(label)
                .font(VFont.labelSmall)
                .foregroundStyle(VColor.contentTertiary)
            Text(value)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }
}

#if DEBUG
import SwiftUI

struct ModifiersGallerySection: View {
    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            // MARK: - .vCard()
            GallerySectionHeader(
                title: ".vCard(radius:)",
                description: "View modifier that applies card styling with configurable corner radius."
            )

            VCard {
                HStack(spacing: VSpacing.lg) {
                    ForEach([
                        ("xs", VRadius.xs),
                        ("sm", VRadius.sm),
                        ("md", VRadius.md),
                        ("lg", VRadius.lg),
                        ("xl", VRadius.xl)
                    ], id: \.0) { name, radius in
                        VStack(spacing: VSpacing.md) {
                            Text("Sample content")
                                .font(VFont.body)
                                .foregroundColor(VColor.textPrimary)
                                .padding(VSpacing.xl)
                                .vCard(radius: radius)

                            Text(".\(name) (\(Int(radius))pt)")
                                .font(VFont.small)
                                .foregroundColor(VColor.textMuted)
                        }
                    }
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - .vHover()
            GallerySectionHeader(
                title: ".vHover()",
                description: "Adds a subtle background highlight on mouse hover."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("Hover over the items below:")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)

                    ForEach(["First item", "Second item", "Third item"], id: \.self) { item in
                        Text(item)
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                            .padding(VSpacing.md)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .vHover()
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    }
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - .vPanelBackground()
            GallerySectionHeader(
                title: ".vPanelBackground()",
                description: "Fills the view with the subtle background color used for panels."
            )

            HStack(spacing: VSpacing.lg) {
                VStack(spacing: VSpacing.md) {
                    Text("With .vPanelBackground()")
                        .font(VFont.small)
                        .foregroundColor(VColor.textMuted)

                    VStack(spacing: VSpacing.md) {
                        Text("Panel content")
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                    }
                    .frame(width: 200, height: 100)
                    .vPanelBackground()
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
                }

                VStack(spacing: VSpacing.md) {
                    Text("Without (default background)")
                        .font(VFont.small)
                        .foregroundColor(VColor.textMuted)

                    VStack(spacing: VSpacing.md) {
                        Text("Regular content")
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                    }
                    .frame(width: 200, height: 100)
                    .background(VColor.background)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
                }
            }
        }
    }
}
#endif

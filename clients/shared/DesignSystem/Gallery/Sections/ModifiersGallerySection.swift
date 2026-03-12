#if DEBUG
import SwiftUI

struct ModifiersGallerySection: View {
    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            // MARK: - .vCard()
            GallerySectionHeader(
                title: ".vCard(radius:background:)",
                description: "View modifier that applies card styling with configurable corner radius and background color."
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
                                .foregroundColor(VColor.contentDefault)
                                .padding(VSpacing.xl)
                                .vCard(radius: radius)

                            Text(".\(name) (\(Int(radius))pt)")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                        }
                    }
                }
            }

            // Background colors
            Text("Background Colors")
                .font(VFont.headline)
                .foregroundColor(VColor.contentSecondary)

            VCard {
                HStack(spacing: VSpacing.lg) {
                    ForEach([
                        ("surface", VColor.surfaceBase),
                        ("background", VColor.surfaceOverlay),
                        ("accent", VColor.primaryBase),
                        ("success", VColor.systemPositiveStrong),
                        ("error", VColor.systemNegativeStrong),
                    ], id: \.0) { name, color in
                        VStack(spacing: VSpacing.md) {
                            Text("Sample content")
                                .font(VFont.body)
                                .foregroundColor(VColor.contentDefault)
                                .padding(VSpacing.xl)
                                .vCard(background: color)

                            Text(name)
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                        }
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - .vHover()
            GallerySectionHeader(
                title: ".vHover()",
                description: "Adds a subtle background highlight on mouse hover."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("Hover over the items below:")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)

                    ForEach(["First item", "Second item", "Third item"], id: \.self) { item in
                        Text(item)
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                            .padding(VSpacing.md)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .vHover()
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - .pointerCursor()
            GallerySectionHeader(
                title: ".pointerCursor()",
                description: "Shows a pointing-hand cursor on hover. Uses native .pointerStyle(.link) on macOS 15+, falls back to NSCursor on macOS 14."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("Hover over the items below to see the pointer cursor:")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)

                    HStack(spacing: VSpacing.lg) {
                        Button("Button") {}
                            .buttonStyle(.plain)
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                            .padding(VSpacing.md)
                            .background(VColor.surfaceBase)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.sm)
                                    .stroke(VColor.borderBase, lineWidth: 1)
                            )
                            .pointerCursor()

                        Text("Tappable label")
                            .font(VFont.body)
                            .foregroundColor(VColor.primaryBase)
                            .padding(VSpacing.md)
                            .contentShape(Rectangle())
                            .pointerCursor()
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - .vPanelBackground()
            GallerySectionHeader(
                title: ".vPanelBackground()",
                description: "Fills the view with the subtle background color used for panels."
            )

            HStack(spacing: VSpacing.lg) {
                VStack(spacing: VSpacing.md) {
                    Text("With .vPanelBackground()")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)

                    VStack(spacing: VSpacing.md) {
                        Text("Panel content")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                    }
                    .frame(width: 200, height: 100)
                    .vPanelBackground()
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                }

                VStack(spacing: VSpacing.md) {
                    Text("Without (default background)")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)

                    VStack(spacing: VSpacing.md) {
                        Text("Regular content")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                    }
                    .frame(width: 200, height: 100)
                    .background(VColor.surfaceOverlay)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                }
            }
        }
    }
}
#endif

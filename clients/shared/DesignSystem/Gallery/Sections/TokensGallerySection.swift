#if DEBUG
import SwiftUI

struct TokensGallerySection: View {
    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            // MARK: - Colors: Semantic
            GallerySectionHeader(
                title: "Colors",
                description: "Semantic color tokens for consistent theming."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    Text("Semantic Tokens")
                        .font(VFont.headline)
                        .foregroundColor(VColor.textPrimary)

                    let semanticColors: [(String, Color)] = [
                        ("background", VColor.background),
                        ("backgroundSubtle", VColor.backgroundSubtle),
                        ("surface", VColor.surface),
                        ("surfaceBorder", VColor.surfaceBorder),
                        ("textPrimary", VColor.textPrimary),
                        ("textSecondary", VColor.textSecondary),
                        ("textMuted", VColor.textMuted),
                        ("accent", VColor.accent),
                        ("accentSubtle", VColor.accentSubtle),
                        ("success", VColor.success),
                        ("error", VColor.error),
                        ("warning", VColor.warning),
                    ]

                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: VSpacing.md), count: 4), spacing: VSpacing.md) {
                        ForEach(semanticColors, id: \.0) { name, color in
                            VStack(spacing: VSpacing.xs) {
                                RoundedRectangle(cornerRadius: VRadius.sm)
                                    .fill(color)
                                    .frame(height: 40)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: VRadius.sm)
                                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                                    )
                                Text(name)
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textMuted)
                            }
                        }
                    }
                }
            }

            // Color scales
            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    Text("Color Scales")
                        .font(VFont.headline)
                        .foregroundColor(VColor.textPrimary)

                    colorScaleRow(name: "Stone", colors: [
                        Stone._950, Stone._900, Stone._800, Stone._700, Stone._600,
                        Stone._500, Stone._400, Stone._300, Stone._200, Stone._100
                    ])
                    colorScaleRow(name: "Moss", colors: [
                        Moss._950, Moss._900, Moss._700, Moss._600,
                        Moss._500, Moss._400, Moss._300, Moss._200, Moss._100
                    ])
                    colorScaleRow(name: "Forest", colors: [
                        Forest._950, Forest._900, Forest._800, Forest._700, Forest._600,
                        Forest._500, Forest._400, Forest._300, Forest._200, Forest._100
                    ])
                    colorScaleRow(name: "Emerald", colors: [
                        Emerald._950, Emerald._900, Emerald._800, Emerald._700, Emerald._600,
                        Emerald._500, Emerald._400, Emerald._300, Emerald._200, Emerald._100
                    ])
                    colorScaleRow(name: "Danger", colors: [
                        Danger._950, Danger._900, Danger._800, Danger._700, Danger._600,
                        Danger._500, Danger._400, Danger._300, Danger._200, Danger._100
                    ])
                    colorScaleRow(name: "Amber", colors: [
                        Amber._950, Amber._900, Amber._800, Amber._700, Amber._600,
                        Amber._500, Amber._400, Amber._300, Amber._200, Amber._100
                    ])
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Typography
            GallerySectionHeader(
                title: "Typography",
                description: "Font scale tokens for consistent text styling."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    typographySample("largeTitle", font: VFont.largeTitle)
                    typographySample("title", font: VFont.title)
                    typographySample("headline", font: VFont.headline)
                    typographySample("body", font: VFont.body)
                    typographySample("bodyMedium", font: VFont.bodyMedium)
                    typographySample("bodyBold", font: VFont.bodyBold)
                    typographySample("caption", font: VFont.caption)
                    typographySample("captionMedium", font: VFont.captionMedium)
                    typographySample("small", font: VFont.small)
                    typographySample("mono", font: VFont.mono)
                    typographySample("monoSmall", font: VFont.monoSmall)
                    typographySample("display", font: VFont.display)
                    typographySample("cardTitle", font: VFont.cardTitle)
                    typographySample("inviteCode", font: VFont.inviteCode)
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Spacing
            GallerySectionHeader(
                title: "Spacing",
                description: "Spacing scale tokens for consistent layout."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    let spacings: [(String, CGFloat)] = [
                        ("xxs", VSpacing.xxs), ("xs", VSpacing.xs), ("sm", VSpacing.sm),
                        ("md", VSpacing.md), ("lg", VSpacing.lg), ("xl", VSpacing.xl),
                        ("xxl", VSpacing.xxl), ("xxxl", VSpacing.xxxl),
                    ]

                    ForEach(spacings, id: \.0) { name, value in
                        HStack(spacing: VSpacing.lg) {
                            Text("\(name) (\(Int(value))pt)")
                                .font(VFont.mono)
                                .foregroundColor(VColor.textSecondary)
                                .frame(width: 120, alignment: .trailing)
                            RoundedRectangle(cornerRadius: VRadius.xs)
                                .fill(VColor.accent)
                                .frame(width: value, height: 16)
                        }
                    }
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Radius
            GallerySectionHeader(
                title: "Radius",
                description: "Corner radius tokens for consistent rounding."
            )

            VCard {
                HStack(spacing: VSpacing.xl) {
                    let radii: [(String, CGFloat)] = [
                        ("xs", VRadius.xs), ("sm", VRadius.sm), ("md", VRadius.md),
                        ("lg", VRadius.lg), ("xl", VRadius.xl), ("pill", VRadius.pill),
                    ]

                    ForEach(radii, id: \.0) { name, radius in
                        VStack(spacing: VSpacing.md) {
                            RoundedRectangle(cornerRadius: radius)
                                .fill(VColor.accent.opacity(0.3))
                                .frame(width: 60, height: 60)
                                .overlay(
                                    RoundedRectangle(cornerRadius: radius)
                                        .stroke(VColor.accent, lineWidth: 2)
                                )
                            Text(name)
                                .font(VFont.captionMedium)
                                .foregroundColor(VColor.textSecondary)
                            Text("\(Int(radius))pt")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                    }
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Shadows
            GallerySectionHeader(
                title: "Shadows",
                description: "Shadow tokens for depth and emphasis."
            )

            VCard {
                HStack(spacing: VSpacing.xxl) {
                    let shadows: [(String, VShadow.Definition)] = [
                        ("sm", VShadow.sm), ("md", VShadow.md), ("lg", VShadow.lg),
                        ("glow", VShadow.glow), ("accentGlow", VShadow.accentGlow),
                    ]

                    ForEach(shadows, id: \.0) { name, shadow in
                        VStack(spacing: VSpacing.lg) {
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .fill(VColor.surface)
                                .frame(width: 80, height: 80)
                                .vShadow(shadow)
                            Text(name)
                                .font(VFont.captionMedium)
                                .foregroundColor(VColor.textSecondary)
                        }
                    }
                }
                .padding(VSpacing.xl)
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - Animations
            GallerySectionHeader(
                title: "Animations",
                description: "Animation timing tokens."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    let animations: [(String, String)] = [
                        ("snappy", "0.12s easeOut"),
                        ("fast", "0.15s easeOut"),
                        ("standard", "0.25s easeInOut"),
                        ("slow", "0.4s easeInOut"),
                        ("spring", "response: 0.3, damping: 0.8"),
                        ("panel", "response: 0.35, damping: 0.85"),
                        ("bouncy", "response: 0.3, damping: 0.5"),
                    ]

                    ForEach(animations, id: \.0) { name, description in
                        HStack(spacing: VSpacing.lg) {
                            Text(name)
                                .font(VFont.mono)
                                .foregroundColor(VColor.textPrimary)
                                .frame(width: 80, alignment: .trailing)
                            Text(description)
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                    }
                }
            }
        }
    }

    private func colorScaleRow(name: String, colors: [Color]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(name)
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textSecondary)
            HStack(spacing: 2) {
                ForEach(0..<colors.count, id: \.self) { i in
                    Rectangle()
                        .fill(colors[i])
                        .frame(height: 32)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        }
    }

    private func typographySample(_ name: String, font: Font) -> some View {
        HStack(spacing: VSpacing.lg) {
            Text(name)
                .font(VFont.mono)
                .foregroundColor(VColor.textMuted)
                .frame(width: 140, alignment: .trailing)
            Text("The quick brown fox jumps")
                .font(font)
                .foregroundColor(VColor.textPrimary)
        }
    }
}
#endif

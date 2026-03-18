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
                        .foregroundColor(VColor.contentDefault)

                    let semanticTokens = VSemanticColorToken.allCases

                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: VSpacing.md), count: 3), spacing: VSpacing.md) {
                        ForEach(semanticTokens, id: \.rawValue) { token in
                            let pair = VColor.pair(for: token)
                            VStack(spacing: VSpacing.xs) {
                                HStack(spacing: VSpacing.xs) {
                                    tokenSwatch(color: pair.lightColor, label: "L")
                                    tokenSwatch(color: pair.darkColor, label: "D")
                                }
                                Text(token.rawValue)
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.contentSecondary)
                                Text("\(pair.lightHex) / \(pair.darkHex)")
                                    .font(VFont.small)
                                    .foregroundColor(VColor.contentTertiary)
                            }
                        }
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

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
                    typographySample("modalTitle", font: VFont.modalTitle)
                    typographySample("cardTitle", font: VFont.cardTitle)
                    typographySample("inviteCode", font: VFont.inviteCode)
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

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
                                .foregroundColor(VColor.contentSecondary)
                                .frame(width: 120, alignment: .trailing)
                            RoundedRectangle(cornerRadius: VRadius.xs)
                                .fill(VColor.primaryBase)
                                .frame(width: value, height: 16)
                        }
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - Radius
            GallerySectionHeader(
                title: "Radius",
                description: "Corner radius tokens for consistent rounding."
            )

            VCard {
                HStack(spacing: VSpacing.xl) {
                    let radii: [(String, CGFloat)] = [
                        ("xs", VRadius.xs), ("sm", VRadius.sm), ("md", VRadius.md),
                        ("window", VRadius.window), ("lg", VRadius.lg), ("xl", VRadius.xl),
                        ("pill", VRadius.pill),
                    ]

                    ForEach(radii, id: \.0) { name, radius in
                        VStack(spacing: VSpacing.md) {
                            RoundedRectangle(cornerRadius: radius)
                                .fill(VColor.primaryBase.opacity(0.3))
                                .frame(width: 60, height: 60)
                                .overlay(
                                    RoundedRectangle(cornerRadius: radius)
                                        .stroke(VColor.primaryBase, lineWidth: 2)
                                )
                            Text(name)
                                .font(VFont.captionMedium)
                                .foregroundColor(VColor.contentSecondary)
                            Text("\(Int(radius))pt")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                        }
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

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
                                .fill(VColor.surfaceBase)
                                .frame(width: 80, height: 80)
                                .vShadow(shadow)
                            Text(name)
                                .font(VFont.captionMedium)
                                .foregroundColor(VColor.contentSecondary)
                        }
                    }
                }
                .padding(VSpacing.xl)
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

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
                                .foregroundColor(VColor.contentDefault)
                                .frame(width: 80, alignment: .trailing)
                            Text(description)
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                        }
                    }
                }
            }
        }
    }

    private func typographySample(_ name: String, font: Font) -> some View {
        HStack(spacing: VSpacing.lg) {
            Text(name)
                .font(VFont.mono)
                .foregroundColor(VColor.contentTertiary)
                .frame(width: 140, alignment: .trailing)
            Text("The quick brown fox jumps")
                .font(font)
                .foregroundColor(VColor.contentDefault)
        }
    }

    private func tokenSwatch(color: Color, label: String) -> some View {
        RoundedRectangle(cornerRadius: VRadius.sm)
            .fill(color)
            .frame(height: 40)
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .stroke(VColor.borderBase, lineWidth: 1)
            )
            .overlay(alignment: .topLeading) {
                Text(label)
                    .font(VFont.small)
                    .foregroundColor(VColor.contentTertiary)
                    .padding(4)
            }
    }
}
#endif

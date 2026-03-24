#if DEBUG
import SwiftUI

struct TokensGallerySection: View {
    var filter: String?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            if filter == nil || filter == "colors" {
                // MARK: - VColor
                GallerySectionHeader(
                    title: "VColor",
                    description: "Semantic color tokens for consistent theming."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Semantic Tokens")
                            .font(VFont.bodySmallEmphasised)
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
                                        .font(VFont.labelDefault)
                                        .foregroundColor(VColor.contentSecondary)
                                    Text("\(pair.lightHex) / \(pair.darkHex)")
                                        .font(VFont.labelSmall)
                                        .foregroundColor(VColor.contentTertiary)
                                }
                            }
                        }
                    }
                }

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Syntax Colors")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundColor(VColor.contentDefault)

                        let syntaxTokens: [(String, Color)] = [
                            ("syntaxString", VColor.syntaxString),
                            ("syntaxNumber", VColor.syntaxNumber),
                            ("syntaxKeyword", VColor.syntaxKeyword),
                            ("syntaxComment", VColor.syntaxComment),
                            ("syntaxType", VColor.syntaxType),
                            ("syntaxProperty", VColor.syntaxProperty),
                            ("syntaxLink", VColor.syntaxLink),
                        ]

                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: VSpacing.md), count: 3), spacing: VSpacing.md) {
                            ForEach(syntaxTokens, id: \.0) { name, color in
                                VStack(spacing: VSpacing.xs) {
                                    RoundedRectangle(cornerRadius: VRadius.sm)
                                        .fill(color)
                                        .frame(height: 40)
                                        .overlay(
                                            RoundedRectangle(cornerRadius: VRadius.sm)
                                                .stroke(VColor.borderBase, lineWidth: 1)
                                        )
                                    Text(name)
                                        .font(VFont.labelDefault)
                                        .foregroundColor(VColor.contentSecondary)
                                }
                            }
                        }
                    }
                }

            }

            if filter == nil || filter == "typography" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VFont
                GallerySectionHeader(
                    title: "VFont",
                    description: "Font scale tokens for consistent text styling."
                )

                VCard {
                    VStack(alignment: .leading, spacing: 0) {
                        // Column headers
                        typeRow(category: "", size: "", regular: "Regular", medium: "Medium", semiBold: "Semi-bold", isHeader: true)
                        Divider().background(VColor.borderDisabled)

                        // TITLE
                        typeRow(category: "TITLE", size: "24px", regular: nil, medium: ("Title/Large", VFont.titleLarge), semiBold: nil)
                        Divider().background(VColor.borderDisabled)
                        typeRow(category: "", size: "20px", regular: nil, medium: ("Title/Medium", VFont.titleMedium), semiBold: nil)
                        Divider().background(VColor.borderDisabled)
                        typeRow(category: "", size: "18px", regular: nil, medium: nil, semiBold: ("Title/Small", VFont.titleSmall))
                        Divider().background(VColor.borderDisabled)

                        // BODY
                        typeRow(category: "BODY", size: "16px", regular: ("Body/Lighter", VFont.bodyLargeLighter), medium: ("Body/Large Default", VFont.bodyLargeDefault), semiBold: ("Body/Large Emphasised", VFont.bodyLargeEmphasised))
                        Divider().background(VColor.borderDisabled)
                        typeRow(category: "", size: "14px", regular: ("Body/Lighter", VFont.bodyMediumLighter), medium: ("Body/Medium Default", VFont.bodyMediumDefault), semiBold: ("Body/Medium Emphasised", VFont.bodyMediumEmphasised))
                        Divider().background(VColor.borderDisabled)
                        typeRow(category: "", size: "12px", regular: nil, medium: ("Body/Small Default", VFont.bodySmallDefault), semiBold: ("Body/Small Emphasised", VFont.bodySmallEmphasised))
                        Divider().background(VColor.borderDisabled)

                        // LABEL
                        typeRow(category: "LABEL", size: "11px", regular: nil, medium: ("Label/Medium Default", VFont.labelDefault), semiBold: nil)
                        Divider().background(VColor.borderDisabled)
                        typeRow(category: "", size: "10px", regular: nil, medium: ("Label/Small Default", VFont.labelSmall), semiBold: nil)
                        Divider().background(VColor.borderDisabled)

                        // CHAT
                        typeRow(category: "CHAT", size: "16px", regular: nil, medium: ("Chat", VFont.chat), semiBold: nil)
                    }
                }

            }

            if filter == nil || filter == "spacing" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VSpacing
                GallerySectionHeader(
                    title: "VSpacing",
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
                                    .font(VFont.bodySmallDefault)
                                    .foregroundColor(VColor.contentSecondary)
                                    .frame(width: 120, alignment: .trailing)
                                RoundedRectangle(cornerRadius: VRadius.xs)
                                    .fill(VColor.primaryBase)
                                    .frame(width: value, height: 16)
                            }
                        }
                    }
                }

            }

            if filter == nil || filter == "radius" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VRadius
                GallerySectionHeader(
                    title: "VRadius",
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
                                    .font(VFont.labelDefault)
                                    .foregroundColor(VColor.contentSecondary)
                                Text("\(Int(radius))pt")
                                    .font(VFont.labelDefault)
                                    .foregroundColor(VColor.contentTertiary)
                            }
                        }
                    }
                }

            }

            if filter == nil || filter == "shadows" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VShadow
                GallerySectionHeader(
                    title: "VShadow",
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
                                    .font(VFont.labelDefault)
                                    .foregroundColor(VColor.contentSecondary)
                            }
                        }
                    }
                    .padding(VSpacing.xl)
                }

            }

            if filter == nil || filter == "animations" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VAnimation
                GallerySectionHeader(
                    title: "VAnimation",
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
                                    .font(VFont.bodySmallDefault)
                                    .foregroundColor(VColor.contentDefault)
                                    .frame(width: 80, alignment: .trailing)
                                Text(description)
                                    .font(VFont.labelDefault)
                                    .foregroundColor(VColor.contentTertiary)
                            }
                        }
                    }
                }
            }

        }
    }

    private func typeRow(
        category: String,
        size: String,
        regular: String,
        medium: String,
        semiBold: String,
        isHeader: Bool
    ) -> some View {
        HStack(spacing: 0) {
            Text(category)
                .font(VFont.bodySmallEmphasised)
                .foregroundColor(VColor.contentTertiary)
                .frame(width: 70, alignment: .leading)
            Text(size)
                .font(VFont.bodySmallEmphasised)
                .foregroundColor(VColor.contentTertiary)
                .frame(width: 50, alignment: .leading)
            Text(regular)
                .font(VFont.bodySmallEmphasised)
                .foregroundColor(VColor.contentDisabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(medium)
                .font(VFont.bodySmallEmphasised)
                .foregroundColor(VColor.contentDisabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(semiBold)
                .font(VFont.bodySmallEmphasised)
                .foregroundColor(VColor.contentDisabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, VSpacing.sm)
    }

    private func typeRow(
        category: String,
        size: String,
        regular: (String, Font)?,
        medium: (String, Font)?,
        semiBold: (String, Font)?
    ) -> some View {
        HStack(spacing: 0) {
            Text(category)
                .font(VFont.bodySmallEmphasised)
                .foregroundColor(VColor.contentTertiary)
                .frame(width: 70, alignment: .leading)
            Text(size)
                .font(VFont.bodySmallEmphasised)
                .foregroundColor(VColor.contentTertiary)
                .frame(width: 50, alignment: .leading)
            typeCellContent(regular)
                .frame(maxWidth: .infinity, alignment: .leading)
            typeCellContent(medium)
                .frame(maxWidth: .infinity, alignment: .leading)
            typeCellContent(semiBold)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, VSpacing.lg)
    }

    @ViewBuilder
    private func typeCellContent(_ token: (String, Font)?) -> some View {
        if let (name, font) = token {
            Text(name)
                .font(font)
                .foregroundColor(VColor.contentEmphasized)
        } else {
            Color.clear.frame(height: 1)
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
                    .font(VFont.labelSmall)
                    .foregroundColor(VColor.contentTertiary)
                    .padding(4)
            }
    }
}

// MARK: - Component Page Router

extension TokensGallerySection {
    @ViewBuilder
    static func componentPage(_ id: String) -> some View {
        switch id {
        case "colors": TokensGallerySection(filter: "colors")
        case "typography": TokensGallerySection(filter: "typography")
        case "spacing": TokensGallerySection(filter: "spacing")
        case "radius": TokensGallerySection(filter: "radius")
        case "shadows": TokensGallerySection(filter: "shadows")
        case "animations": TokensGallerySection(filter: "animations")
        default: EmptyView()
        }
    }
}
#endif

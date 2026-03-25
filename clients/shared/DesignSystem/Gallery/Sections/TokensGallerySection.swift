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
                            .foregroundStyle(VColor.contentDefault)

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
                                        .foregroundStyle(VColor.contentSecondary)
                                    Text("\(pair.lightHex) / \(pair.darkHex)")
                                        .font(VFont.labelSmall)
                                        .foregroundStyle(VColor.contentTertiary)
                                }
                            }
                        }
                    }
                }

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Syntax Colors")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentDefault)

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
                                        .foregroundStyle(VColor.contentSecondary)
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
                    description: "DM Sans type scale. Each cell renders its own font token."
                )

                // Type matrix (matches Figma node 2193-4447)
                VCard(padding: 0) {
                    VStack(alignment: .leading, spacing: 0) {
                        typeMatrixHeader()
                        typeMatrixDivider()

                        typeMatrixRow(group: "TITLE", size: "24", regular: nil, medium: ("Title/Large", VFont.titleLarge), semiBold: nil)
                        typeMatrixDivider()
                        typeMatrixRow(group: "", size: "20", regular: nil, medium: ("Title/Medium", VFont.titleMedium), semiBold: nil)
                        typeMatrixDivider()
                        typeMatrixRow(group: "", size: "18", regular: nil, medium: nil, semiBold: ("Title/Small", VFont.titleSmall))
                        typeMatrixDivider()

                        typeMatrixRow(group: "BODY", size: "16", regular: ("Body/Lighter", VFont.bodyLargeLighter), medium: ("Body/Large Default", VFont.bodyLargeDefault), semiBold: ("Body/Large Emphasised", VFont.bodyLargeEmphasised))
                        typeMatrixDivider()
                        typeMatrixRow(group: "", size: "14", regular: ("Body/Lighter", VFont.bodyMediumLighter), medium: ("Body/Medium Default", VFont.bodyMediumDefault), semiBold: ("Body/Medium Emphasised", VFont.bodyMediumEmphasised))
                        typeMatrixDivider()
                        typeMatrixRow(group: "", size: "12", regular: nil, medium: ("Body/Small Default", VFont.bodySmallDefault), semiBold: ("Body/Small Emphasised", VFont.bodySmallEmphasised))
                        typeMatrixDivider()

                        typeMatrixRow(group: "LABEL", size: "11", regular: nil, medium: ("Label/Default", VFont.labelDefault), semiBold: nil)
                        typeMatrixDivider()
                        typeMatrixRow(group: "", size: "10", regular: nil, medium: ("Label/Small", VFont.labelSmall), semiBold: nil)
                        typeMatrixDivider()

                        typeMatrixRow(group: "CHAT", size: "16", regular: nil, medium: ("Chat", VFont.chat), semiBold: nil)
                    }
                }

                // Token reference list
                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Token Reference")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentDefault)
                            .padding(.bottom, VSpacing.xs)

                        let tokens: [(String, String, String, Font)] = [
                            ("titleLarge", "Medium 24", "Headings, page titles", VFont.titleLarge),
                            ("titleMedium", "Medium 20", "Section headings", VFont.titleMedium),
                            ("titleSmall", "SemiBold 18", "Card titles, subheadings", VFont.titleSmall),
                            ("bodyLargeLighter", "Regular 16", "Secondary body text", VFont.bodyLargeLighter),
                            ("bodyLargeDefault", "Medium 16", "Primary body text", VFont.bodyLargeDefault),
                            ("bodyLargeEmphasised", "SemiBold 16", "Emphasized body text", VFont.bodyLargeEmphasised),
                            ("bodyMediumLighter", "Regular 14", "Secondary UI text", VFont.bodyMediumLighter),
                            ("bodyMediumDefault", "Medium 14", "Default UI text", VFont.bodyMediumDefault),
                            ("bodyMediumEmphasised", "SemiBold 14", "Emphasized UI text", VFont.bodyMediumEmphasised),
                            ("bodySmallDefault", "Medium 12", "Captions, metadata", VFont.bodySmallDefault),
                            ("bodySmallEmphasised", "SemiBold 12", "Tags, badges", VFont.bodySmallEmphasised),
                            ("labelDefault", "Medium 11", "Form labels, tooltips", VFont.labelDefault),
                            ("labelSmall", "Medium 10", "Fine print, timestamps", VFont.labelSmall),
                            ("chat", "Medium 16 (24px line)", "Chat message text", VFont.chat),
                        ]

                        ForEach(tokens, id: \.0) { name, spec, usage, font in
                            HStack(alignment: .top, spacing: VSpacing.lg) {
                                Text("VFont.\(name)")
                                    .font(VFont.bodySmallDefault)
                                    .foregroundStyle(VColor.contentEmphasized)
                                    .frame(width: 200, alignment: .leading)

                                Text(spec)
                                    .font(VFont.bodySmallDefault)
                                    .foregroundStyle(VColor.contentTertiary)
                                    .frame(width: 130, alignment: .leading)

                                Text(usage)
                                    .font(VFont.bodySmallDefault)
                                    .foregroundStyle(VColor.contentTertiary)
                                    .frame(maxWidth: .infinity, alignment: .leading)

                                Text("Aa")
                                    .font(font)
                                    .foregroundStyle(VColor.contentDefault)
                                    .frame(width: 60, alignment: .trailing)
                            }
                        }
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
                                    .foregroundStyle(VColor.contentSecondary)
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
                                    .foregroundStyle(VColor.contentSecondary)
                                Text("\(Int(radius))pt")
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentTertiary)
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
                                    .foregroundStyle(VColor.contentSecondary)
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
                                    .foregroundStyle(VColor.contentDefault)
                                    .frame(width: 80, alignment: .trailing)
                                Text(description)
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentTertiary)
                            }
                        }
                    }
                }
            }

        }
    }

    // MARK: - Type Matrix Helpers

    private static let matrixGroupWidth: CGFloat = 70
    private static let matrixSizeWidth: CGFloat = 50

    private func typeMatrixDivider() -> some View {
        Rectangle().fill(VColor.borderDisabled).frame(height: 1)
    }

    private func typeMatrixHeader() -> some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: Self.matrixGroupWidth)
            Color.clear.frame(width: Self.matrixSizeWidth)
            Text("Regular")
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentDisabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("Medium")
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentDisabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("Semi-bold")
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentDisabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
    }

    private func typeMatrixRow(
        group: String,
        size: String,
        regular: (String, Font)?,
        medium: (String, Font)?,
        semiBold: (String, Font)?
    ) -> some View {
        HStack(spacing: 0) {
            Text(group)
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentTertiary)
                .frame(width: Self.matrixGroupWidth, alignment: .leading)
            Text("\(size)px")
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentTertiary)
                .frame(width: Self.matrixSizeWidth, alignment: .leading)
            typeMatrixCell(regular)
                .frame(maxWidth: .infinity, alignment: .leading)
            typeMatrixCell(medium)
                .frame(maxWidth: .infinity, alignment: .leading)
            typeMatrixCell(semiBold)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.lg)
    }

    @ViewBuilder
    private func typeMatrixCell(_ token: (String, Font)?) -> some View {
        if let (name, font) = token {
            Text(name)
                .font(font)
                .foregroundStyle(VColor.contentEmphasized)
        } else {
            RoundedRectangle(cornerRadius: VRadius.xs)
                .fill(VColor.surfaceBase.opacity(0.5))
                .frame(height: 20)
                .padding(.trailing, VSpacing.lg)
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
                    .foregroundStyle(VColor.contentTertiary)
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

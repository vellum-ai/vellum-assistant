#if DEBUG
import SwiftUI

struct ButtonsGallerySection: View {
    @State private var selectedStyle: VButton.Style = .primary
    @State private var isFullWidth = false
    @State private var isDisabled = false
    @State private var isActive = false
    @State private var iconOnly = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            // MARK: - VButton
            GallerySectionHeader(
                title: "VButton",
                description: "Primary action button with style, full-width, and disabled options."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    // Controls
                    HStack(spacing: VSpacing.xl) {
                        Picker("Style", selection: $selectedStyle) {
                            Text("Primary").tag(VButton.Style.primary)
                            Text("Ghost").tag(VButton.Style.ghost)
                            Text("Danger").tag(VButton.Style.danger)
                        }
                        .pickerStyle(.segmented)
                        .frame(maxWidth: 300)

                        Toggle("Full Width", isOn: $isFullWidth)
                        Toggle("Disabled", isOn: $isDisabled)
                    }

                    Divider().background(VColor.surfaceBorder)

                    // Live preview
                    VButton(
                        label: "Click Me",
                        style: selectedStyle,
                        isFullWidth: isFullWidth,
                        isDisabled: isDisabled
                    ) {}
                }
            }

            // All Variants grid
            Text("All Variants")
                .font(VFont.headline)
                .foregroundColor(VColor.textSecondary)

            VCard {
                HStack(spacing: VSpacing.xl) {
                    ForEach([VButton.Style.primary, .ghost, .danger], id: \.self) { style in
                        VStack(spacing: VSpacing.md) {
                            VButton(label: styleName(style), style: style) {}
                            VButton(label: "Disabled", style: style, isDisabled: true) {}
                            VButton(label: "Full Width", style: style, isFullWidth: true) {}
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - VIconButton
            GallerySectionHeader(
                title: "VIconButton",
                description: "Compact button with SF Symbol icon and optional label."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    HStack(spacing: VSpacing.xl) {
                        Toggle("Active", isOn: $isActive)
                        Toggle("Icon Only", isOn: $iconOnly)
                    }

                    Divider().background(VColor.surfaceBorder)

                    HStack(spacing: VSpacing.lg) {
                        VIconButton(label: "Settings", icon: "gear", isActive: isActive, iconOnly: iconOnly) {}
                        VIconButton(label: "Refresh", icon: "arrow.clockwise", isActive: isActive, iconOnly: iconOnly) {}
                        VIconButton(label: "Add", icon: "plus", isActive: isActive, iconOnly: iconOnly) {}
                    }
                }
            }

            // All VIconButton variants
            Text("All Variants")
                .font(VFont.headline)
                .foregroundColor(VColor.textSecondary)

            VCard {
                HStack(spacing: VSpacing.xl) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Default").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VIconButton(label: "Edit", icon: "pencil") {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Active").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VIconButton(label: "Edit", icon: "pencil", isActive: true) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Icon Only").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VIconButton(label: "Edit", icon: "pencil", iconOnly: true) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Active + Icon Only").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VIconButton(label: "Edit", icon: "pencil", isActive: true, iconOnly: true) {}
                    }
                }
            }
        }
    }

    private func styleName(_ style: VButton.Style) -> String {
        switch style {
        case .primary: return "Primary"
        case .ghost: return "Ghost"
        case .danger: return "Danger"
        }
    }
}
#endif

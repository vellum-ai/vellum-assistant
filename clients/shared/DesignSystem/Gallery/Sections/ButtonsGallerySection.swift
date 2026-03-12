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
                        VSegmentedControl(
                            items: [
                                (label: "Primary", tag: VButton.Style.primary),
                                (label: "Tertiary", tag: VButton.Style.tertiary),
                                (label: "Secondary", tag: VButton.Style.secondary),
                                (label: "Danger", tag: VButton.Style.danger),
                            ],
                            selection: $selectedStyle,
                            style: .pill
                        )
                        .frame(maxWidth: 300)

                        Toggle("Full Width", isOn: $isFullWidth)
                        Toggle("Disabled", isOn: $isDisabled)
                    }

                    Divider().background(VColor.borderBase)

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
                .foregroundColor(VColor.contentSecondary)

            VCard {
                HStack(spacing: VSpacing.xl) {
                    ForEach([VButton.Style.primary, .tertiary, .secondary, .danger], id: \.self) { style in
                        VStack(spacing: VSpacing.md) {
                            VButton(label: styleName(style), style: style) {}
                            VButton(label: "Disabled", style: style, isDisabled: true) {}
                            VButton(label: "Full Width", style: style, isFullWidth: true) {}
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
            }

            // All Sizes
            Text("All Sizes")
                .font(VFont.headline)
                .foregroundColor(VColor.contentSecondary)

            VCard {
                HStack(spacing: VSpacing.xl) {
                    ForEach([VButton.Size.small, .medium, .large], id: \.self) { size in
                        VStack(spacing: VSpacing.md) {
                            Text(sizeName(size))
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                            VButton(label: sizeName(size), style: .primary, size: size) {}
                            VButton(label: sizeName(size), style: .secondary, size: size) {}
                            VButton(label: sizeName(size), style: .tertiary, size: size) {}
                            VButton(label: sizeName(size), style: .danger, size: size) {}
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VIconButton
            GallerySectionHeader(
                title: "VIconButton",
                description: "Compact button with icon and optional label."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    HStack(spacing: VSpacing.xl) {
                        Toggle("Active", isOn: $isActive)
                        Toggle("Icon Only", isOn: $iconOnly)
                    }

                    Divider().background(VColor.borderBase)

                    HStack(spacing: VSpacing.lg) {
                        VIconButton(label: "Settings", icon: VIcon.settings.rawValue, isActive: isActive, iconOnly: iconOnly) {}
                        VIconButton(label: "Refresh", icon: VIcon.refreshCw.rawValue, isActive: isActive, iconOnly: iconOnly) {}
                        VIconButton(label: "Add", icon: VIcon.plus.rawValue, isActive: isActive, iconOnly: iconOnly) {}
                    }
                }
            }

            // All VIconButton variants
            Text("All Variants")
                .font(VFont.headline)
                .foregroundColor(VColor.contentSecondary)

            VCard {
                HStack(spacing: VSpacing.xl) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Default").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VIconButton(label: "Edit", icon: VIcon.pencil.rawValue) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Active").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VIconButton(label: "Edit", icon: VIcon.pencil.rawValue, isActive: true) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Icon Only").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VIconButton(label: "Edit", icon: VIcon.pencil.rawValue, iconOnly: true) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Active + Icon Only").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VIconButton(label: "Edit", icon: VIcon.pencil.rawValue, isActive: true, iconOnly: true) {}
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VIconButton (Semantic Variants)
            GallerySectionHeader(
                title: "VIconButton (Semantic Variants)",
                description: "Filled icon buttons using semantic variants aligned with VButton styles."
            )

            VCard {
                HStack(spacing: VSpacing.xl) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Primary").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VIconButton(label: "More", icon: VIcon.ellipsis.rawValue, iconOnly: true, variant: .primary) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Secondary").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VIconButton(label: "Add", icon: VIcon.plus.rawValue, iconOnly: true, variant: .secondary) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Danger").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VIconButton(label: "Delete", icon: VIcon.trash.rawValue, iconOnly: true, variant: .danger) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Neutral").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VIconButton(label: "Stop", icon: VIcon.square.rawValue, iconOnly: true, variant: .neutral) {}
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VIconButton (Outlined)
            GallerySectionHeader(
                title: "VIconButton (Outlined)",
                description: "Outlined icon buttons with a border and transparent background."
            )

            VCard {
                HStack(spacing: VSpacing.xl) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Close").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VIconButton(label: "Close", icon: VIcon.x.rawValue, iconOnly: true, variant: .outlined) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("History").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VIconButton(label: "History", icon: VIcon.history.rawValue, iconOnly: true, variant: .outlined) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Publish").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VIconButton(label: "Publish", icon: VIcon.arrowUpRight.rawValue, iconOnly: true, variant: .outlined) {}
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VIconButton (Icon Only)
            GallerySectionHeader(
                title: "VIconButton (Icon Only)",
                description: "Icon-only buttons for compact actions like close, add, and call."
            )

            VCard {
                HStack(spacing: VSpacing.xl) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Add").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VIconButton(label: "Add", icon: VIcon.plus.rawValue, iconOnly: true) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Call").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VIconButton(label: "Call", icon: VIcon.phoneCall.rawValue, iconOnly: true) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Record").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VIconButton(label: "Record", icon: VIcon.mic.rawValue, iconOnly: true) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Close").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VIconButton(label: "Close", icon: VIcon.x.rawValue, iconOnly: true) {}
                    }
                }
            }
        }
    }

    private func styleName(_ style: VButton.Style) -> String {
        switch style {
        case .primary: return "Primary"
        case .tertiary: return "Tertiary"
        case .secondary: return "Secondary"
        case .danger: return "Danger"
        case .ghost: return "Ghost"
        case .outlined: return "Outlined"
        case .success: return "Success"
        }
    }

    private func sizeName(_ size: VButton.Size) -> String {
        switch size {
        case .small: return "Small"
        case .medium: return "Medium"
        case .large: return "Large"
        }
    }
}
#endif

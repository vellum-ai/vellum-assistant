#if DEBUG
import SwiftUI

struct ButtonsGallerySection: View {
    @State private var selectedStyle: VButton.Style = .primary
    @State private var isFullWidth = false
    @State private var isDisabled = false
    @State private var isActive = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            // MARK: - VButton (Text + Icon)
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
                                (label: "Outlined", tag: VButton.Style.outlined),
                                (label: "Danger", tag: VButton.Style.danger),
                                (label: "Danger Outline", tag: VButton.Style.dangerOutline),
                                (label: "Ghost", tag: VButton.Style.ghost),
                                (label: "Contrast", tag: VButton.Style.contrast),
                            ],
                            selection: $selectedStyle,
                            style: .pill
                        )
                        .frame(maxWidth: 600)

                        Toggle("Full Width", isOn: $isFullWidth)
                        Toggle("Disabled", isOn: $isDisabled)
                    }

                    Divider().background(VColor.borderBase)

                    // Live preview
                    HStack(spacing: VSpacing.lg) {
                        VButton(
                            label: "With Icons",
                            leftIcon: VIcon.zap.rawValue,
                            rightIcon: VIcon.arrowUpRight.rawValue,
                            style: selectedStyle,
                            isFullWidth: isFullWidth,
                            isDisabled: isDisabled
                        ) {}
                        VButton(
                            label: "Left Icon",
                            leftIcon: VIcon.zap.rawValue,
                            style: selectedStyle,
                            isFullWidth: isFullWidth,
                            isDisabled: isDisabled
                        ) {}
                        VButton(
                            label: "Text Only",
                            style: selectedStyle,
                            isFullWidth: isFullWidth,
                            isDisabled: isDisabled
                        ) {}
                    }
                }
            }

            // All Variants grid
            Text("All Variants")
                .font(VFont.headline)
                .foregroundColor(VColor.contentSecondary)

            VCard {
                HStack(spacing: VSpacing.xl) {
                    ForEach([VButton.Style.primary, .outlined, .danger, .dangerOutline, .ghost, .contrast], id: \.self) { style in
                        VStack(spacing: VSpacing.md) {
                            VButton(label: styleName(style), style: style) {}
                            VButton(label: "Disabled", style: style, isDisabled: true) {}
                            VButton(label: "Full Width", style: style, isFullWidth: true) {}
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VButton (Icon Only — Ghost)
            GallerySectionHeader(
                title: "VButton (Icon Only — Ghost)",
                description: "Ghost icon-only buttons with optional active state."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    HStack(spacing: VSpacing.xl) {
                        Toggle("Active", isOn: $isActive)
                    }

                    Divider().background(VColor.borderBase)

                    HStack(spacing: VSpacing.lg) {
                        VButton(label: "Settings", iconOnly: VIcon.settings.rawValue, style: .ghost, isActive: isActive) {}
                        VButton(label: "Refresh", iconOnly: VIcon.refreshCw.rawValue, style: .ghost, isActive: isActive) {}
                        VButton(label: "Add", iconOnly: VIcon.plus.rawValue, style: .ghost, isActive: isActive) {}
                    }
                }
            }

            // Ghost states
            Text("Ghost States")
                .font(VFont.headline)
                .foregroundColor(VColor.contentSecondary)

            VCard {
                HStack(spacing: VSpacing.xl) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Default").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VButton(label: "Edit", iconOnly: VIcon.pencil.rawValue, style: .ghost) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Active").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VButton(label: "Edit", iconOnly: VIcon.pencil.rawValue, style: .ghost, isActive: true) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Disabled").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VButton(label: "Edit", iconOnly: VIcon.pencil.rawValue, style: .ghost, isDisabled: true) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Active + Disabled").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VButton(label: "Edit", iconOnly: VIcon.pencil.rawValue, style: .ghost, isDisabled: true, isActive: true) {}
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VButton (Icon Only — Semantic Variants)
            GallerySectionHeader(
                title: "VButton (Icon Only — Semantic Variants)",
                description: "Filled icon-only buttons using semantic styles."
            )

            VCard {
                HStack(spacing: VSpacing.xl) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Primary").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VButton(label: "More", iconOnly: VIcon.ellipsis.rawValue, style: .primary) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Danger").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VButton(label: "Delete", iconOnly: VIcon.trash.rawValue, style: .danger) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Contrast").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VButton(label: "Stop", iconOnly: VIcon.square.rawValue, style: .contrast) {}
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VButton (Icon Only — Outlined)
            GallerySectionHeader(
                title: "VButton (Icon Only — Outlined)",
                description: "Outlined icon-only buttons with a border and transparent background."
            )

            VCard {
                HStack(spacing: VSpacing.xl) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Close").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VButton(label: "Close", iconOnly: VIcon.x.rawValue, style: .outlined) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("History").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VButton(label: "History", iconOnly: VIcon.history.rawValue, style: .outlined) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Publish").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VButton(label: "Publish", iconOnly: VIcon.arrowUpRight.rawValue, style: .outlined) {}
                    }
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VButton (Icon Only — Compact)
            GallerySectionHeader(
                title: "VButton (Icon Only — Compact)",
                description: "Icon-only buttons for compact actions like close, add, and call."
            )

            VCard {
                HStack(spacing: VSpacing.xl) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Add").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VButton(label: "Add", iconOnly: VIcon.plus.rawValue, style: .ghost) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Call").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VButton(label: "Call", iconOnly: VIcon.phoneCall.rawValue, style: .ghost) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Record").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VButton(label: "Record", iconOnly: VIcon.mic.rawValue, style: .ghost) {}
                    }
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Close").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VButton(label: "Close", iconOnly: VIcon.x.rawValue, style: .ghost) {}
                    }
                }
            }
        }
    }

    private func styleName(_ style: VButton.Style) -> String {
        switch style {
        case .primary: return "Primary"
        case .danger: return "Danger"
        case .outlined: return "Outlined"
        case .dangerOutline: return "Danger Outline"
        case .ghost: return "Ghost"
        case .dangerGhost: return "Danger Ghost"
        case .contrast: return "Contrast"
        }
    }
}
#endif

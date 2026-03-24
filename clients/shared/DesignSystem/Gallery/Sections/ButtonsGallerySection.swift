#if DEBUG
import SwiftUI

struct ButtonsGallerySection: View {
    var filter: String?

    @State private var selectedStyle: VButton.Style = .primary
    @State private var isFullWidth = false
    @State private var isDisabled = false
    @State private var isActive = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            if filter == nil || filter == "vButton" {
                // MARK: - VButton (Text + Icon)
                GallerySectionHeader(
                    title: "VButton",
                    description: "Primary action button with style, full-width, and disabled options.",
                    useInsteadOf: "Custom Button with manual styling"
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
                    .font(VFont.bodySmallEmphasised)
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
                    .font(VFont.bodySmallEmphasised)
                    .foregroundColor(VColor.contentSecondary)

                VCard {
                    HStack(spacing: VSpacing.xl) {
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Default").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VButton(label: "Edit", iconOnly: VIcon.pencil.rawValue, style: .ghost) {}
                        }
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Active").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VButton(label: "Edit", iconOnly: VIcon.pencil.rawValue, style: .ghost, isActive: true) {}
                        }
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Disabled").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VButton(label: "Edit", iconOnly: VIcon.pencil.rawValue, style: .ghost, isDisabled: true) {}
                        }
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Active + Disabled").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
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
                            Text("Primary").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VButton(label: "More", iconOnly: VIcon.ellipsis.rawValue, style: .primary) {}
                        }
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Danger").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VButton(label: "Delete", iconOnly: VIcon.trash.rawValue, style: .danger) {}
                        }
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Contrast").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
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
                            Text("Close").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VButton(label: "Close", iconOnly: VIcon.x.rawValue, style: .outlined) {}
                        }
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("History").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VButton(label: "History", iconOnly: VIcon.history.rawValue, style: .outlined) {}
                        }
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Publish").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
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
                            Text("Add").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VButton(label: "Add", iconOnly: VIcon.plus.rawValue, style: .ghost) {}
                        }
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Call").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VButton(label: "Call", iconOnly: VIcon.phoneCall.rawValue, style: .ghost) {}
                        }
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Record").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VButton(label: "Record", iconOnly: VIcon.mic.rawValue, style: .ghost) {}
                        }
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Close").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VButton(label: "Close", iconOnly: VIcon.x.rawValue, style: .ghost) {}
                        }
                    }
                }

                Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

                // MARK: - VButton (Icon Only — Inline)
                GallerySectionHeader(
                    title: "VButton (Icon Only — Inline)",
                    description: "Smallest icon-only buttons (18×18 frame) for inline use within text lines, such as per-node copy buttons in tree views."
                )

                VCard {
                    HStack(spacing: VSpacing.xl) {
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Copy").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VButton(label: "Copy", iconOnly: VIcon.copy.rawValue, style: .ghost, size: .inline) {}
                        }
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Edit").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VButton(label: "Edit", iconOnly: VIcon.pencil.rawValue, style: .ghost, size: .inline) {}
                        }
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Close").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VButton(label: "Close", iconOnly: VIcon.x.rawValue, style: .ghost, size: .inline) {}
                        }
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Inline in text").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            HStack(spacing: VSpacing.xs) {
                                Text("\"key\": \"value\"")
                                    .font(VFont.bodyMediumDefault)
                                    .foregroundColor(VColor.contentDefault)
                                VButton(label: "Copy", iconOnly: VIcon.copy.rawValue, style: .ghost, size: .inline) {}
                            }
                        }
                    }
                }

            }

            if filter == nil || filter == "vSplitButton" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VSplitButton
                GallerySectionHeader(
                    title: "VSplitButton",
                    description: "A split button with a primary action and a dropdown menu for secondary actions."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        Text("Styles")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundColor(VColor.contentSecondary)

                        HStack(spacing: VSpacing.lg) {
                            VStack(alignment: .leading, spacing: VSpacing.md) {
                                Text("Primary").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                                VSplitButton(label: "Allow", icon: VIcon.check.rawValue, style: .primary, action: {}) {
                                    Section("Duration") {
                                        Button("Allow once") {}
                                        Button("Allow for this session") {}
                                    }
                                    Section("Scope") {
                                        Button("Allow for this project") {}
                                        Button("Allow always") {}
                                    }
                                }
                            }

                            VStack(alignment: .leading, spacing: VSpacing.md) {
                                Text("Outlined").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                                VSplitButton(label: "Save", style: .outlined, action: {}) {
                                    Button("Save as draft") {}
                                    Button("Save and publish") {}
                                    Button("Save as template") {}
                                }
                            }

                            VStack(alignment: .leading, spacing: VSpacing.md) {
                                Text("Danger").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                                VSplitButton(label: "Delete", icon: VIcon.trash.rawValue, style: .danger, action: {}) {
                                    Button("Delete selected") {}
                                    Button("Delete all") {}
                                }
                            }

                            VStack(alignment: .leading, spacing: VSpacing.md) {
                                Text("Long Label").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                                VSplitButton(label: "Allow for this conversation", icon: VIcon.check.rawValue, style: .primary, action: {}) {
                                    Button("Allow once") {}
                                    Button("Allow always") {}
                                }
                            }
                        }
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

// MARK: - Component Page Router

extension ButtonsGallerySection {
    @ViewBuilder
    static func componentPage(_ id: String) -> some View {
        switch id {
        case "vButton": ButtonsGallerySection(filter: "vButton")
        case "vSplitButton": ButtonsGallerySection(filter: "vSplitButton")
        default: EmptyView()
        }
    }
}
#endif

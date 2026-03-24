#if DEBUG
import SwiftUI

struct ModifiersGallerySection: View {
    var filter: String?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            if filter == nil || filter == "vCardMod" {
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
                                    .font(VFont.bodyMediumLighter)
                                    .foregroundColor(VColor.contentDefault)
                                    .padding(VSpacing.xl)
                                    .vCard(radius: radius)

                                Text(".\(name) (\(Int(radius))pt)")
                                    .font(VFont.labelDefault)
                                    .foregroundColor(VColor.contentTertiary)
                            }
                        }
                    }
                }

                // Background colors
                Text("Background Colors")
                    .font(VFont.bodySmallEmphasised)
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
                                    .font(VFont.bodyMediumLighter)
                                    .foregroundColor(VColor.contentDefault)
                                    .padding(VSpacing.xl)
                                    .vCard(background: color)

                                Text(name)
                                    .font(VFont.labelDefault)
                                    .foregroundColor(VColor.contentTertiary)
                            }
                        }
                    }
                }
            }

            if filter == nil || filter == "pointerCursor" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - .pointerCursor()
                GallerySectionHeader(
                    title: ".pointerCursor()",
                    description: "Shows a pointing-hand cursor on hover. Uses native .pointerStyle(.link) on macOS 15+, falls back to NSCursor on macOS 14."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Hover over the items below to see the pointer cursor:")
                            .font(VFont.labelDefault)
                            .foregroundColor(VColor.contentSecondary)

                        HStack(spacing: VSpacing.lg) {
                            Button("Button") {}
                                .buttonStyle(.plain)
                                .font(VFont.bodyMediumLighter)
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
                                .font(VFont.bodyMediumLighter)
                                .foregroundColor(VColor.primaryBase)
                                .padding(VSpacing.md)
                                .contentShape(Rectangle())
                                .pointerCursor()
                        }
                    }
                }
            }

            if filter == nil || filter == "nativeTooltip" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - .nativeTooltip()
                GallerySectionHeader(
                    title: ".nativeTooltip(_:)",
                    description: "Attaches a native macOS tooltip via AppKit's NSView.toolTip. Use instead of .help() in views where gesture recognizers prevent .help() tooltips from appearing. Falls back to .help() on non-macOS platforms."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Hover over the items below to see native tooltips:")
                            .font(VFont.labelDefault)
                            .foregroundColor(VColor.contentSecondary)

                        HStack(spacing: VSpacing.lg) {
                            VIconView(.pin, size: 16)
                                .foregroundColor(VColor.contentSecondary)
                                .frame(width: 32, height: 32)
                                .background(VColor.surfaceBase)
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                                .nativeTooltip("Pinned")

                            VIconView(.circleAlert, size: 16)
                                .foregroundColor(VColor.systemNegativeStrong)
                                .frame(width: 32, height: 32)
                                .background(VColor.surfaceBase)
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                                .nativeTooltip("Error")

                            VIconView(.lock, size: 16)
                                .foregroundColor(VColor.primaryBase)
                                .frame(width: 32, height: 32)
                                .background(VColor.surfaceBase)
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                                .nativeTooltip("Private conversation")
                        }
                    }
                }
            }

            if filter == nil || filter == "vTooltip" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - .vTooltip()
                GallerySectionHeader(
                    title: ".vTooltip(_:edge:delay:)",
                    description: "Fast floating tooltip (200ms default). Uses an NSPanel so it escapes clipping, never steals clicks, and works on any view — buttons, icons, text, containers. Supports edge placement (.top default, .bottom). Falls back to .help() on non-macOS."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Hover over the items below (200ms delay):")
                            .font(VFont.labelDefault)
                            .foregroundColor(VColor.contentSecondary)

                        HStack(spacing: VSpacing.lg) {
                            VButton(label: "Mic", iconOnly: VIcon.mic.rawValue, style: .ghost) {}
                                .vTooltip("Click to dictate or hold Fn")

                            VButton(label: "Voice", iconOnly: VIcon.audioWaveform.rawValue, style: .ghost) {}
                                .vTooltip("Live voice conversation")

                            VButton(label: "Send", iconOnly: VIcon.arrowUp.rawValue, style: .primary, isDisabled: true) {}
                                .vTooltip("Send message")

                            VIconView(.info, size: 16)
                                .foregroundColor(VColor.contentTertiary)
                                .frame(width: 32, height: 32)
                                .background(VColor.surfaceBase)
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                                .vTooltip("Works on any view, not just buttons")
                        }

                        Text("Bottom edge placement:")
                            .font(VFont.labelDefault)
                            .foregroundColor(VColor.contentSecondary)

                        HStack(spacing: VSpacing.lg) {
                            VButton(label: "Copy", iconOnly: VIcon.copy.rawValue, style: .ghost) {}
                                .vTooltip("Copy message", edge: .bottom)

                            VButton(label: "Fork", iconOnly: VIcon.gitBranch.rawValue, style: .ghost) {}
                                .vTooltip("Fork from here", edge: .bottom)
                        }
                    }
                }
            }

            if filter == nil || filter == "vPanelBackground" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - .vPanelBackground()
                GallerySectionHeader(
                    title: ".vPanelBackground()",
                    description: "Fills the view with the subtle background color used for panels."
                )

                HStack(spacing: VSpacing.lg) {
                    VStack(spacing: VSpacing.md) {
                        Text("With .vPanelBackground()")
                            .font(VFont.labelDefault)
                            .foregroundColor(VColor.contentTertiary)

                        VStack(spacing: VSpacing.md) {
                            Text("Panel content")
                                .font(VFont.bodyMediumLighter)
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
                            .font(VFont.labelDefault)
                            .foregroundColor(VColor.contentTertiary)

                        VStack(spacing: VSpacing.md) {
                            Text("Regular content")
                                .font(VFont.bodyMediumLighter)
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

            if filter == nil || filter == "ifMod" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - .if()
                GallerySectionHeader(
                    title: ".if(_:transform:)",
                    description: "Conditionally applies a transformation to a view. When the condition is true, the transform closure is applied; otherwise the view is returned unchanged."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("condition = true (bold applied)")
                            .font(VFont.labelDefault)
                            .foregroundColor(VColor.contentSecondary)

                        Text("Hello, world!")
                            .font(VFont.bodyMediumLighter)
                            .foregroundColor(VColor.contentDefault)
                            .if(true) { view in
                                view.bold()
                            }

                        Divider().background(VColor.borderBase)

                        Text("condition = false (no change)")
                            .font(VFont.labelDefault)
                            .foregroundColor(VColor.contentSecondary)

                        Text("Hello, world!")
                            .font(VFont.bodyMediumLighter)
                            .foregroundColor(VColor.contentDefault)
                            .if(false) { view in
                                view.bold()
                            }
                    }
                }
            }

            if filter == nil || filter == "vShimmer" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - .vShimmer()
                GallerySectionHeader(
                    title: ".vShimmer()",
                    description: "Sweeps a translucent highlight across the view for skeleton loading. Respects reduced motion."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        VStack(alignment: .leading, spacing: VSpacing.sm) {
                            HStack(spacing: VSpacing.md) {
                                VSkeletonBone(width: 40, height: 40, radius: VRadius.pill)
                                VStack(alignment: .leading, spacing: VSpacing.sm) {
                                    VSkeletonBone(width: 120, height: 14)
                                    VSkeletonBone(width: 80, height: 12)
                                }
                            }
                            VSkeletonBone(height: 14)
                            VSkeletonBone(width: 240, height: 14)
                            VSkeletonBone(width: 180, height: 14)
                        }
                        .vShimmer()
                    }
                }
            }

            if filter == nil || filter == "inlineWidgetCard" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - .inlineWidgetCard()
                GallerySectionHeader(
                    title: ".inlineWidgetCard()",
                    description: "Standard card chrome for inline chat widgets. Applies padding, background, border, and optional hover highlight."
                )

                VCard {
                    HStack(spacing: VSpacing.lg) {
                        VStack(spacing: VSpacing.md) {
                            Text("Non-interactive (default)").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            Text("Widget content")
                                .font(VFont.bodyMediumLighter)
                                .foregroundColor(VColor.contentDefault)
                                .inlineWidgetCard()
                        }
                        VStack(spacing: VSpacing.md) {
                            Text("Interactive (hover highlight)").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            Text("Clickable widget")
                                .font(VFont.bodyMediumLighter)
                                .foregroundColor(VColor.contentDefault)
                                .inlineWidgetCard(interactive: true)
                        }
                    }
                }
            }

        }
    }
}

// MARK: - Component Page Router

extension ModifiersGallerySection {
    @ViewBuilder
    static func componentPage(_ id: String) -> some View {
        switch id {
        case "vCardMod": ModifiersGallerySection(filter: "vCardMod")
        case "pointerCursor": ModifiersGallerySection(filter: "pointerCursor")
        case "nativeTooltip": ModifiersGallerySection(filter: "nativeTooltip")
        case "vTooltip": ModifiersGallerySection(filter: "vTooltip")
        case "vPanelBackground": ModifiersGallerySection(filter: "vPanelBackground")
        case "ifMod": ModifiersGallerySection(filter: "ifMod")
        case "vShimmer": ModifiersGallerySection(filter: "vShimmer")
        case "inlineWidgetCard": ModifiersGallerySection(filter: "inlineWidgetCard")
        default: EmptyView()
        }
    }
}
#endif

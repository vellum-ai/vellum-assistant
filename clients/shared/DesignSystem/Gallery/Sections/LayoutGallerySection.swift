#if DEBUG
import SwiftUI

struct LayoutGallerySection: View {
    @State private var showPanel = true
    @State private var panelWidth: Double = 280
    @State private var pinnedTabSelection: Int = 0

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            // MARK: - VToolbar
            GallerySectionHeader(
                title: "VToolbar",
                description: "Horizontal toolbar container for icon buttons and actions."
            )

            VCard(padding: 0) {
                VToolbar {
                    VIconButton(label: "Home", icon: "house") {}
                    VIconButton(label: "Search", icon: "magnifyingglass") {}
                    VIconButton(label: "Settings", icon: "gear", isActive: true) {}
                    Spacer()
                    VIconButton(label: "Add", icon: "plus", iconOnly: true) {}
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - VSidePanel
            GallerySectionHeader(
                title: "VSidePanel",
                description: "Side panel with title header and close button."
            )

            VCard(padding: 0) {
                VSidePanel(title: "Inspector", onClose: {}) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Panel content goes here")
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                        Text("This panel has a title header with a close button and scrollable content area.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                    }
                }
                .frame(width: 300, height: 200)
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - VSidePanel with Pinned Content
            GallerySectionHeader(
                title: "VSidePanel (Pinned Content)",
                description: "Side panel with sticky pinned content (e.g. tabs) above the scrollable area."
            )

            VCard(padding: 0) {
                VSidePanel(title: "Control", onClose: {}, pinnedContent: {
                    VSegmentedControl(
                        items: ["Profile", "Settings", "Channels", "Overview"],
                        selection: $pinnedTabSelection
                    )
                    Divider().background(VColor.surfaceBorder)
                }) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Tab \(pinnedTabSelection + 1) content")
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                        Text("The tab bar above stays pinned while this content scrolls.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                    }
                }
                .frame(width: 300, height: 250)
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - VSplitView
            GallerySectionHeader(
                title: "VSplitView",
                description: "Split layout with main content and a togglable side panel."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    HStack(spacing: VSpacing.xl) {
                        Toggle("Show Panel", isOn: $showPanel)
                        VStack(alignment: .leading) {
                            Text("Panel Width: \(Int(panelWidth))")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textSecondary)
                            Slider(value: $panelWidth, in: 200...400, step: 20)
                                .frame(maxWidth: 200)
                        }
                    }

                    Divider().background(VColor.surfaceBorder)

                    VSplitView(
                        panelWidth: $panelWidth,
                        showPanel: showPanel
                    ) {
                        VStack {
                            Text("Main Content")
                                .font(VFont.panelTitle)
                                .foregroundColor(VColor.textPrimary)
                            Text("This is the primary area")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textSecondary)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(VColor.surface)
                    } panel: {
                        VSidePanel(title: "Details", onClose: { showPanel = false }) {
                            Text("Side panel content")
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                        }
                    }
                    .frame(height: 250)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
                }
            }
        }
    }
}
#endif

#if DEBUG
import SwiftUI

struct LayoutGallerySection: View {
    @State private var showPanel = true
    @State private var panelWidth: Double = 280
    @State private var pinnedTabSelection: Int = 0

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            // MARK: - VModal
            GallerySectionHeader(
                title: "VModal",
                description: "Standardized modal container with title, optional subtitle, scrollable content, and optional footer."
            )

            VCard(padding: 0) {
                VModal(title: "Set PIN", subtitle: "This is a subtitle.") {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Tool Name")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                            Text("Select a Tool")
                                .font(VFont.body)
                                .foregroundColor(VColor.contentSecondary)
                                .padding(VSpacing.sm)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(VColor.surfaceActive)
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                        }
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Tool Name")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                            Text("Select a Tool")
                                .font(VFont.body)
                                .foregroundColor(VColor.contentSecondary)
                                .padding(VSpacing.sm)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(VColor.surfaceActive)
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                        }
                    }
                } footer: {
                    HStack {
                        Spacer()
                        VButton(label: "Cancel", style: .outlined) {}
                        VButton(label: "Confirm", style: .primary) {}
                    }
                }
                .frame(width: 360, height: 320)
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VModal (Navigation)
            GallerySectionHeader(
                title: "VModal (Navigation)",
                description: "Modal with back and close navigation actions. The back button replaces the title; the close button appears in the trailing position."
            )

            VCard(padding: 0) {
                VModal(title: "", closeAction: {}, backAction: {}) {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Sub-screen content goes here")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                        Text("Use backAction and closeAction to add navigation controls to the modal header.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                    }
                }
                .frame(width: 360, height: 200)
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VToolbar
            GallerySectionHeader(
                title: "VToolbar",
                description: "Horizontal toolbar container for icon buttons and actions."
            )

            VCard(padding: 0) {
                VToolbar {
                    VButton(label: "Home", icon: VIcon.house.rawValue, style: .ghost) {}
                    VButton(label: "Search", icon: VIcon.search.rawValue, style: .ghost) {}
                    VButton(label: "Settings", icon: VIcon.settings.rawValue, style: .ghost, isActive: true) {}
                    Spacer()
                    VButton(label: "Add", iconOnly: VIcon.plus.rawValue, style: .ghost) {}
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VSidePanel
            GallerySectionHeader(
                title: "VSidePanel",
                description: "Side panel with title header and close button."
            )

            VCard(padding: 0) {
                VSidePanel(title: "Inspector", onClose: {}, pinnedContent: { EmptyView() }) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Panel content goes here")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                        Text("This panel has a title header with a close button and scrollable content area.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                    }
                }
                .frame(width: 300, height: 200)
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

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
                    Divider().background(VColor.borderBase)
                }) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Tab \(pinnedTabSelection + 1) content")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                        Text("The tab bar above stays pinned while this content scrolls.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                    }
                }
                .frame(width: 300, height: 250)
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

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
                                .foregroundColor(VColor.contentSecondary)
                            Slider(value: $panelWidth, in: 200...400, step: 20)
                                .frame(maxWidth: 200)
                        }
                    }

                    Divider().background(VColor.borderBase)

                    VSplitView(
                        panelWidth: $panelWidth,
                        showPanel: showPanel
                    ) {
                        VStack {
                            Text("Main Content")
                                .font(VFont.panelTitle)
                                .foregroundColor(VColor.contentDefault)
                            Text("This is the primary area")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentSecondary)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(VColor.surfaceBase)
                    } panel: {
                        VSidePanel(title: "Details", onClose: { showPanel = false }, pinnedContent: { EmptyView() }) {
                            Text("Side panel content")
                                .font(VFont.body)
                                .foregroundColor(VColor.contentSecondary)
                        }
                    }
                    .frame(height: 250)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                }
            }
        }
    }
}
#endif

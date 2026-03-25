#if DEBUG
import SwiftUI

struct LayoutGallerySection: View {
    var filter: String?

    @State private var showPanel = true
    @State private var panelWidth: Double = 280
    @State private var pinnedTabSelection: Int = 0
    @State private var adaptiveDropdownValue: String = "a"
    @State private var adaptiveContainerWidth: Double = 500
    @State private var dockWidth: Double = 300
    @State private var showDock: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            if filter == nil || filter == "vModal" {
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
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentTertiary)
                                Text("Select a Tool")
                                    .font(VFont.bodyMediumLighter)
                                    .foregroundStyle(VColor.contentSecondary)
                                    .padding(VSpacing.sm)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(VColor.surfaceActive)
                                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                            }
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Tool Name")
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentTertiary)
                                Text("Select a Tool")
                                    .font(VFont.bodyMediumLighter)
                                    .foregroundStyle(VColor.contentSecondary)
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
                                .font(VFont.bodyMediumLighter)
                                .foregroundStyle(VColor.contentDefault)
                            Text("Use backAction and closeAction to add navigation controls to the modal header.")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentSecondary)
                        }
                    }
                    .frame(width: 360, height: 200)
                }
            }

            if filter == nil || filter == "vAdaptiveStack" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VAdaptiveStack
                GallerySectionHeader(
                    title: "VAdaptiveStack",
                    description: "Arranges content horizontally when space allows, falling back to vertical stacking. Uses ViewThatFits to pick the best layout for the available width.",
                    useInsteadOf: "Raw ViewThatFits { HStack { } VStack { } } in feature code"
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Container Width: \(Int(adaptiveContainerWidth))pt")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentSecondary)
                            Slider(value: $adaptiveContainerWidth, in: 150...600, step: 10)
                                .frame(maxWidth: 300)
                        }

                        Divider().background(VColor.borderBase)

                        VAdaptiveStack(horizontalAlignment: .bottom) {
                            VDropdown(
                                placeholder: "Select a model...",
                                selection: $adaptiveDropdownValue,
                                options: [
                                    (label: "Claude 3.5 Sonnet", value: "a"),
                                    (label: "GPT-4o", value: "b"),
                                    (label: "Gemini Pro", value: "c"),
                                ]
                            )
                            VButton(label: "Save", style: .primary) {}
                        }
                        .frame(width: adaptiveContainerWidth, alignment: .leading)
                    }
                }
            }

            if filter == nil || filter == "vSidePanel" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VSidePanel
                GallerySectionHeader(
                    title: "VSidePanel",
                    description: "Side panel with title header and close button."
                )

                VCard(padding: 0) {
                    VSidePanel(title: "Inspector", onClose: {}, pinnedContent: { EmptyView() }) {
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Panel content goes here")
                                .font(VFont.bodyMediumLighter)
                                .foregroundStyle(VColor.contentDefault)
                            Text("This panel has a title header with a close button and scrollable content area.")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentSecondary)
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
                        VTabs(
                            items: ["Profile", "Settings", "Channels", "Overview"],
                            selection: $pinnedTabSelection
                        )
                        Divider().background(VColor.borderBase)
                    }) {
                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Tab \(pinnedTabSelection + 1) content")
                                .font(VFont.bodyMediumLighter)
                                .foregroundStyle(VColor.contentDefault)
                            Text("The tab bar above stays pinned while this content scrolls.")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentSecondary)
                        }
                    }
                    .frame(width: 300, height: 250)
                }
            }

            if filter == nil || filter == "vSplitView" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
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
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentSecondary)
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
                                    .font(VFont.titleLarge)
                                    .foregroundStyle(VColor.contentDefault)
                                Text("This is the primary area")
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentSecondary)
                            }
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(VColor.surfaceBase)
                        } panel: {
                            VSidePanel(title: "Details", onClose: { showPanel = false }, pinnedContent: { EmptyView() }) {
                                Text("Side panel content")
                                    .font(VFont.bodyMediumLighter)
                                    .foregroundStyle(VColor.contentSecondary)
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

            if filter == nil || filter == "vAppWorkspaceDockLayout" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VAppWorkspaceDockLayout
                GallerySectionHeader(
                    title: "VAppWorkspaceDockLayout",
                    description: "Workspace layout with a togglable, resizable dock panel and a draggable divider."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        HStack(spacing: VSpacing.xl) {
                            Toggle("Show Dock", isOn: $showDock)
                            Text("Dock Width: \(Int(dockWidth))")
                                .font(VFont.bodyMediumDefault)
                                .foregroundStyle(VColor.contentTertiary)
                        }

                        Divider().background(VColor.borderBase)

                        VAppWorkspaceDockLayout(
                            dockWidth: $dockWidth,
                            showDock: showDock
                        ) {
                            VStack {
                                VIconView(.panelLeft, size: 20)
                                    .foregroundStyle(VColor.contentTertiary)
                                Text("Dock")
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentSecondary)
                            }
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(VColor.surfaceOverlay)
                        } workspace: {
                            VStack {
                                VIconView(.layoutGrid, size: 20)
                                    .foregroundStyle(VColor.contentTertiary)
                                Text("Workspace")
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentSecondary)
                            }
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(VColor.surfaceBase)
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
}

// MARK: - Component Page Router

extension LayoutGallerySection {
    @ViewBuilder
    static func componentPage(_ id: String) -> some View {
        switch id {
        case "vModal": LayoutGallerySection(filter: "vModal")
        case "vAdaptiveStack": LayoutGallerySection(filter: "vAdaptiveStack")
        case "vSidePanel": LayoutGallerySection(filter: "vSidePanel")
        case "vSplitView": LayoutGallerySection(filter: "vSplitView")
        case "vAppWorkspaceDockLayout": LayoutGallerySection(filter: "vAppWorkspaceDockLayout")
        default: EmptyView()
        }
    }
}
#endif

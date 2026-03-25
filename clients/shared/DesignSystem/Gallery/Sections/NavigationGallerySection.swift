#if DEBUG
import SwiftUI

struct NavigationGallerySection: View {
    var filter: String?

    @State private var segmentSelection = 0
    @State private var pillSelection = "active"
    @State private var compactPillSelection = "preview"
    @State private var sidebarRowActive = "Intelligence"
    @State private var sidebarDisclosureExpanded = true

    private let segmentItems = ["All", "Active", "Archived", "Drafts"]
    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            if filter == nil || filter == "vSegmentedControl" {
                // MARK: - VTabs
                GallerySectionHeader(
                    title: "VTabs",
                    description: "Underlined segmented control for switching between views."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        Text("Selected: \(segmentItems[segmentSelection])")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentTertiary)

                        Divider().background(VColor.borderBase)

                        VTabs(items: segmentItems, selection: $segmentSelection)

                        // Show a placeholder for the selected segment
                        VCard {
                            Text("Content for \"\(segmentItems[segmentSelection])\" tab")
                                .font(VFont.bodyMediumLighter)
                                .foregroundStyle(VColor.contentSecondary)
                                .frame(maxWidth: .infinity)
                                .padding(VSpacing.xl)
                        }
                    }
                }

                Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

                // MARK: - VTabs (Pill)
                GallerySectionHeader(
                    title: "VTabs (Pill)",
                    description: "Pill-style segmented control with filled accent background on selection."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        Text("Selected: \(pillSelection)")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentTertiary)

                        Divider().background(VColor.borderBase)

                        VTabs(
                            items: [
                                (label: "All", tag: "all"),
                                (label: "Active", tag: "active"),
                                (label: "Archived", tag: "archived"),
                            ],
                            selection: $pillSelection,
                            style: .pill
                        )
                        .frame(maxWidth: 300)
                    }
                }

                Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

                // MARK: - VTabs (Compact Pill)
                GallerySectionHeader(
                    title: "VTabs (Compact Pill)",
                    description: "Compact pill-style segmented control for inline use in toolbars and headers."
                )

                VCard(padding: VSpacing.lg) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Divider().background(VColor.borderBase)

                        VTabs(
                            items: [
                                (label: "Preview", tag: "preview"),
                                (label: "Source", tag: "source"),
                            ],
                            selection: $compactPillSelection,
                            style: .pill,
                            size: .compact
                        )
                        .fixedSize()
                    }
                }

            }

            if filter == nil || filter == "vSidebarRow" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VSidebarRow
                GallerySectionHeader(
                    title: "VSidebarRow",
                    description: "Sidebar navigation row with icon, label, hover/active states, and optional trailing icon. Used by the main app sidebar and the component gallery."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("States").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                        VSidebarRow(icon: VIcon.brain.rawValue, label: "Intelligence", isActive: sidebarRowActive == "Intelligence") {
                            sidebarRowActive = "Intelligence"
                        }
                        VSidebarRow(icon: VIcon.bookOpen.rawValue, label: "Library", isActive: sidebarRowActive == "Library") {
                            sidebarRowActive = "Library"
                        }
                        VSidebarRow(icon: VIcon.settings.rawValue, label: "Settings", isActive: sidebarRowActive == "Settings") {
                            sidebarRowActive = "Settings"
                        }
                    }
                }

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Without Icon").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                        VSidebarRow(label: "Overview", isActive: false) {}
                        VSidebarRow(label: "VButton", isActive: true) {}
                        VSidebarRow(label: "VSplitButton", isActive: false) {}
                    }
                }

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Trailing Icon (Disclosure)").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                        VSidebarRow(
                            icon: VIcon.layers.rawValue,
                            label: "Display",
                            trailingIcon: VIcon.chevronRight.rawValue,
                            trailingIconRotation: .degrees(sidebarDisclosureExpanded ? 90 : 0)
                        ) {
                            withAnimation(VAnimation.fast) {
                                sidebarDisclosureExpanded.toggle()
                            }
                        }

                        if sidebarDisclosureExpanded {
                            VSidebarRow(label: "VCard", isActive: false) {}
                                .padding(.leading, VSpacing.md)
                            VSidebarRow(label: "VEmptyState", isActive: false) {}
                                .padding(.leading, VSpacing.md)
                        }
                    }
                }

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Trailing Content").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                        VSidebarRow(label: "All", isActive: true, action: {}) {
                            Text("42")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentTertiary)
                        }
                        VSidebarRow(label: "Identity", action: {}) {
                            Text("12")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentTertiary)
                        }
                        VSidebarRow(label: "Preference", action: {}) {
                            Text("8")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentTertiary)
                        }
                    }
                }

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Collapsed Mode").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                        HStack(spacing: VSpacing.md) {
                            VSidebarRow(icon: VIcon.brain.rawValue, label: "Intelligence", isExpanded: false) {}
                            VSidebarRow(icon: VIcon.bookOpen.rawValue, label: "Library", isActive: true, isExpanded: false) {}
                            VSidebarRow(icon: VIcon.settings.rawValue, label: "Settings", isExpanded: false) {}
                        }
                        .frame(maxWidth: 200)
                    }
                }
            }


            if filter == nil || filter == "vLink" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VLink
                GallerySectionHeader(
                    title: "VLink",
                    description: "Styled external link that opens a URL in the default browser. Applies pointer cursor, single-line truncation, and caption font by default."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Default (caption)").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            HStack(spacing: 0) {
                                Text("Telegram ID: ").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VLink("123456789", destination: URL(string: "https://web.telegram.org")!)
                            }
                        }
                        Divider().background(VColor.borderBase)
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Body font").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VLink("@example_bot", destination: URL(string: "https://t.me/example_bot")!, font: VFont.bodyMediumLighter)
                        }
                    }
                }
            }

            if filter == nil || filter == "vThemeToggle" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VThemeToggle
                GallerySectionHeader(
                    title: "VThemeToggle",
                    description: "Three-way theme toggle (System / Light / Dark). Reads and writes the themePreference key in UserDefaults and applies the appearance app-wide."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Icon Pill (default)").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VThemeToggle()
                        }
                        Divider().background(VColor.borderBase)
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Label Pill").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VThemeToggle(style: .labelPill)
                        }
                        Divider().background(VColor.borderBase)
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("No label").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VThemeToggle(showLabel: false)
                        }
                    }
                }
            }

        }
    }
}

// MARK: - Component Page Router

extension NavigationGallerySection {
    @ViewBuilder
    static func componentPage(_ id: String) -> some View {
        switch id {
        case "vSegmentedControl": NavigationGallerySection(filter: "vSegmentedControl")
        case "vSidebarRow": NavigationGallerySection(filter: "vSidebarRow")
        case "vLink": NavigationGallerySection(filter: "vLink")
        case "vThemeToggle": NavigationGallerySection(filter: "vThemeToggle")
        default: EmptyView()
        }
    }
}
#endif

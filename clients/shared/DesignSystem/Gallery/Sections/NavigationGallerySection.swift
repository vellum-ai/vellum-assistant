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

            if filter == nil || filter == "vNavItem" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VNavItem
                GallerySectionHeader(
                    title: "VNavItem",
                    description: "Sidebar navigation row with icon, label, hover/active states, and optional trailing icon. Used by the main app sidebar and the component gallery."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("States").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                        VNavItem(icon: VIcon.brain.rawValue, label: "Intelligence", isActive: sidebarRowActive == "Intelligence") {
                            sidebarRowActive = "Intelligence"
                        }
                        VNavItem(icon: VIcon.bookOpen.rawValue, label: "Library", isActive: sidebarRowActive == "Library") {
                            sidebarRowActive = "Library"
                        }
                        VNavItem(icon: VIcon.settings.rawValue, label: "Settings", isActive: sidebarRowActive == "Settings") {
                            sidebarRowActive = "Settings"
                        }
                    }
                }

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Without Icon").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                        VNavItem(label: "Overview", isActive: false) {}
                        VNavItem(label: "VButton", isActive: true) {}
                        VNavItem(label: "VSplitButton", isActive: false) {}
                    }
                }

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Trailing Icon (Disclosure)").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                        VNavItem(
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
                            VNavItem(label: "VCard", isActive: false) {}
                                .padding(.leading, VSpacing.md)
                            VNavItem(label: "VEmptyState", isActive: false) {}
                                .padding(.leading, VSpacing.md)
                        }
                    }
                }

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Trailing Content").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                        VNavItem(label: "All", isActive: true, action: {}) {
                            Text("42")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentTertiary)
                        }
                        VNavItem(label: "Identity", action: {}) {
                            Text("12")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentTertiary)
                        }
                        VNavItem(label: "Preference", action: {}) {
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
                            VNavItem(icon: VIcon.brain.rawValue, label: "Intelligence", isExpanded: false) {}
                            VNavItem(icon: VIcon.bookOpen.rawValue, label: "Library", isActive: true, isExpanded: false) {}
                            VNavItem(icon: VIcon.settings.rawValue, label: "Settings", isExpanded: false) {}
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

            if filter == nil || filter == "vMenu" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VMenu (Simple Action Menu)
                GallerySectionHeader(
                    title: "VMenu",
                    description: "Reusable popover container with section headers, dividers, action items, and custom rows. Use instead of manual drawer chrome."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Simple Action Menu").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                        VMenu {
                            VMenuItem(icon: VIcon.copy.rawValue, label: "Copy") {}
                            VMenuItem(icon: VIcon.gitBranch.rawValue, label: "Fork") {}
                            VMenuItem(icon: VIcon.archive.rawValue, label: "Archive") {}
                        }
                    }
                }

                Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

                // MARK: - VMenu (Sections)
                GallerySectionHeader(
                    title: "VMenu with Sections",
                    description: "VMenuSection groups items with an optional header label and divider."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Menu with Section Headers").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                        VMenu {
                            VMenuItem(icon: VIcon.pencil.rawValue, label: "Edit") {}
                            VMenuItem(icon: VIcon.copy.rawValue, label: "Duplicate") {}

                            VMenuSection(header: "Analytics") {
                                VMenuItem(icon: VIcon.barChart.rawValue, label: "View Stats") {}
                                VMenuItem(icon: VIcon.scrollText.rawValue, label: "View Logs") {}
                            }

                            VMenuSection(header: "Danger Zone") {
                                VMenuItem(icon: VIcon.archive.rawValue, label: "Archive") {}
                            }
                        }
                    }
                }

                Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

                // MARK: - VMenu (Active Item)
                GallerySectionHeader(
                    title: "VMenu with Active Item",
                    description: "A VMenuItem with isActive: true shows the highlighted/selected state."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Active Item Highlight").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                        VMenu {
                            VMenuItem(icon: VIcon.pin.rawValue, label: "Pinned") {}
                            VMenuItem(icon: VIcon.settings.rawValue, label: "Settings", isActive: true) {}
                            VMenuItem(icon: VIcon.externalLink.rawValue, label: "Open External") {}
                        }
                    }
                }

                Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

                // MARK: - VMenu (Custom Row)
                GallerySectionHeader(
                    title: "VMenu with Custom Row",
                    description: "VMenuCustomRow embeds arbitrary content in a menu with consistent horizontal alignment."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Custom Row Content").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                        VMenu {
                            VMenuItem(icon: VIcon.settings.rawValue, label: "Settings") {}
                            VMenuDivider()
                            VMenuCustomRow {
                                HStack {
                                    Text("Theme")
                                        .font(VFont.bodySmallDefault)
                                        .foregroundStyle(VColor.contentDefault)
                                    Spacer()
                                    VThemeToggle(showLabel: false)
                                }
                                .padding(.vertical, VSpacing.xs)
                            }
                            VMenuDivider()
                            VMenuItem(icon: VIcon.logOut.rawValue, label: "Sign Out") {}
                        }
                    }
                }

                Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

                // MARK: - VMenu (Fixed Width)
                GallerySectionHeader(
                    title: "VMenu with Fixed Width",
                    description: "Pass a width parameter to constrain the menu to a fixed size."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        Text("Fixed Width (200pt)").font(VFont.bodySmallEmphasised).foregroundStyle(VColor.contentSecondary)

                        VMenu(width: 200) {
                            VMenuItem(icon: VIcon.copy.rawValue, label: "Copy") {}
                            VMenuItem(icon: VIcon.gitBranch.rawValue, label: "Fork") {}
                            VMenuDivider()
                            VMenuItem(icon: VIcon.archive.rawValue, label: "Archive") {}
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
        case "vNavItem": NavigationGallerySection(filter: "vNavItem")
        case "vLink": NavigationGallerySection(filter: "vLink")
        case "vThemeToggle": NavigationGallerySection(filter: "vThemeToggle")
        case "vMenu": NavigationGallerySection(filter: "vMenu")
        default: EmptyView()
        }
    }
}
#endif

#if DEBUG
import SwiftUI

struct NavigationGallerySection: View {
    var filter: String?

    @State private var segmentSelection = 0
    @State private var pillSelection = "active"
    @State private var compactPillSelection = "preview"
    @State private var selectedTab = 0
    @State private var sidebarRowActive = "Intelligence"
    @State private var sidebarDisclosureExpanded = true

    private let segmentItems = ["All", "Active", "Archived", "Drafts"]
    private let tabs = [
        (label: "Dashboard", icon: VIcon.house.rawValue),
        (label: "Conversations", icon: VIcon.list.rawValue),
        (label: "Settings", icon: VIcon.settings.rawValue),
        (label: "Logs", icon: VIcon.fileText.rawValue),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            if filter == nil || filter == "vSegmentedControl" {
                // MARK: - VSegmentedControl
                GallerySectionHeader(
                    title: "VSegmentedControl",
                    description: "Underlined segmented control for switching between views."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        Text("Selected: \(segmentItems[segmentSelection])")
                            .font(VFont.mono)
                            .foregroundColor(VColor.contentTertiary)

                        Divider().background(VColor.borderBase)

                        VSegmentedControl(items: segmentItems, selection: $segmentSelection)

                        // Show a placeholder for the selected segment
                        VCard {
                            Text("Content for \"\(segmentItems[segmentSelection])\" tab")
                                .font(VFont.bodyMediumLighter)
                                .foregroundColor(VColor.contentSecondary)
                                .frame(maxWidth: .infinity)
                                .padding(VSpacing.xl)
                        }
                    }
                }

                Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

                // MARK: - VSegmentedControl (Pill)
                GallerySectionHeader(
                    title: "VSegmentedControl (Pill)",
                    description: "Pill-style segmented control with filled accent background on selection."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        Text("Selected: \(pillSelection)")
                            .font(VFont.mono)
                            .foregroundColor(VColor.contentTertiary)

                        Divider().background(VColor.borderBase)

                        VSegmentedControl(
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

                // MARK: - VSegmentedControl (Compact Pill)
                GallerySectionHeader(
                    title: "VSegmentedControl (Compact Pill)",
                    description: "Compact pill-style segmented control for inline use in toolbars and headers."
                )

                VCard(padding: VSpacing.lg) {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Divider().background(VColor.borderBase)

                        VSegmentedControl(
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
                        Text("States").font(VFont.bodySmallEmphasised).foregroundColor(VColor.contentSecondary)

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
                        Text("Without Icon").font(VFont.bodySmallEmphasised).foregroundColor(VColor.contentSecondary)

                        VSidebarRow(label: "Overview", isActive: false) {}
                        VSidebarRow(label: "VButton", isActive: true) {}
                        VSidebarRow(label: "VSplitButton", isActive: false) {}
                    }
                }

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Trailing Icon (Disclosure)").font(VFont.bodySmallEmphasised).foregroundColor(VColor.contentSecondary)

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
                        Text("Trailing Content").font(VFont.bodySmallEmphasised).foregroundColor(VColor.contentSecondary)

                        VSidebarRow(label: "All", isActive: true, action: {}) {
                            Text("42")
                                .font(VFont.labelDefault)
                                .foregroundColor(VColor.contentTertiary)
                        }
                        VSidebarRow(label: "Identity", action: {}) {
                            Text("12")
                                .font(VFont.labelDefault)
                                .foregroundColor(VColor.contentTertiary)
                        }
                        VSidebarRow(label: "Preference", action: {}) {
                            Text("8")
                                .font(VFont.labelDefault)
                                .foregroundColor(VColor.contentTertiary)
                        }
                    }
                }

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Collapsed Mode").font(VFont.bodySmallEmphasised).foregroundColor(VColor.contentSecondary)

                        HStack(spacing: VSpacing.md) {
                            VSidebarRow(icon: VIcon.brain.rawValue, label: "Intelligence", isExpanded: false) {}
                            VSidebarRow(icon: VIcon.bookOpen.rawValue, label: "Library", isActive: true, isExpanded: false) {}
                            VSidebarRow(icon: VIcon.settings.rawValue, label: "Settings", isExpanded: false) {}
                        }
                        .frame(maxWidth: 200)
                    }
                }
            }

            if filter == nil || filter == "vTabBar" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VTabBar + VTab
                GallerySectionHeader(
                    title: "VTabBar + VTab",
                    description: "Horizontal scrollable tab bar with selectable and closeable tabs."
                )

                VCard(padding: 0) {
                    VStack(spacing: 0) {
                        VTabBar {
                            ForEach(Array(tabs.enumerated()), id: \.offset) { index, tab in
                                VTab(
                                    label: tab.label,
                                    icon: tab.icon,
                                    isSelected: selectedTab == index,
                                    isCloseable: index > 0,
                                    onSelect: { selectedTab = index },
                                    onClose: index > 0 ? {} : nil
                                )
                            }
                        }

                        // Content area
                        VStack {
                            Text(tabs[selectedTab].label)
                                .font(VFont.titleMedium)
                                .foregroundColor(VColor.contentDefault)
                            Text("Tab content area")
                                .font(VFont.labelDefault)
                                .foregroundColor(VColor.contentTertiary)
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 120)
                        .background(VColor.surfaceOverlay)
                    }
                }

                // Tab states
                Text("Tab States (Pill)")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundColor(VColor.contentSecondary)

                VCard {
                    HStack(spacing: VSpacing.lg) {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Default").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VTab(label: "Tab", icon: VIcon.file.rawValue, onSelect: {})
                        }
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Selected").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VTab(label: "Tab", icon: VIcon.file.rawValue, isSelected: true, onSelect: {})
                        }
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Not closeable").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VTab(label: "Tab", icon: VIcon.file.rawValue, isCloseable: false, onSelect: {})
                        }
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("No icon").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VTab(label: "Plain Tab", isCloseable: false, onSelect: {})
                        }
                    }
                }

                // Flat-style tab states
                Text("Tab States (Flat)")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundColor(VColor.contentSecondary)

                VCard {
                    HStack(spacing: VSpacing.lg) {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Default").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VTab(label: "Conversation 1", style: .flat, onSelect: {})
                        }
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Selected").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VTab(label: "Conversation 1", isSelected: true, style: .flat, onSelect: {})
                        }
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Closeable").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VTab(label: "Conversation 2", style: .flat, onSelect: {}, onClose: {})
                        }
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Selected + Closeable").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VTab(label: "Conversation 2", isSelected: true, style: .flat, onSelect: {}, onClose: {})
                        }
                    }
                }

                // Rectangular-style tab states
                Text("Tab States (Rectangular)")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundColor(VColor.contentSecondary)

                VCard {
                    HStack(spacing: VSpacing.lg) {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Default").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VTab(label: "Tab", icon: VIcon.file.rawValue, style: .rectangular, onSelect: {})
                        }
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Selected").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VTab(label: "Tab", icon: VIcon.file.rawValue, isSelected: true, style: .rectangular, onSelect: {})
                        }
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Closeable").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VTab(label: "Tab", icon: VIcon.file.rawValue, style: .rectangular, onSelect: {}, onClose: {})
                        }
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Selected + Closeable").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VTab(label: "Tab", icon: VIcon.file.rawValue, isSelected: true, style: .rectangular, onSelect: {}, onClose: {})
                        }
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
                            Text("Icon Pill (default)").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VThemeToggle()
                        }
                        Divider().background(VColor.borderBase)
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Label Pill").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
                            VThemeToggle(style: .labelPill)
                        }
                        Divider().background(VColor.borderBase)
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("No label").font(VFont.labelDefault).foregroundColor(VColor.contentTertiary)
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
        case "vTabBar": NavigationGallerySection(filter: "vTabBar")
        case "vSidebarRow": NavigationGallerySection(filter: "vSidebarRow")
        case "vLink": NavigationGallerySection(filter: "vLink")
        case "vThemeToggle": NavigationGallerySection(filter: "vThemeToggle")
        default: EmptyView()
        }
    }
}
#endif

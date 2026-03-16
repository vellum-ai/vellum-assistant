#if DEBUG
import SwiftUI

struct NavigationGallerySection: View {
    @State private var segmentSelection = 0
    @State private var pillSelection = "active"
    @State private var selectedTab = 0

    private let segmentItems = ["All", "Active", "Archived", "Drafts"]
    private let tabs = [
        (label: "Dashboard", icon: VIcon.house.rawValue),
        (label: "Conversations", icon: VIcon.list.rawValue),
        (label: "Settings", icon: VIcon.settings.rawValue),
        (label: "Logs", icon: VIcon.fileText.rawValue),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
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
                            .font(VFont.body)
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
                        selection: $pillSelection,
                        style: .pill,
                        size: .compact
                    )
                    .fixedSize()
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

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
                            .font(VFont.title)
                            .foregroundColor(VColor.contentDefault)
                        Text("Tab content area")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 120)
                    .background(VColor.surfaceOverlay)
                }
            }

            // Tab states
            Text("Tab States (Pill)")
                .font(VFont.headline)
                .foregroundColor(VColor.contentSecondary)

            VCard {
                HStack(spacing: VSpacing.lg) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Default").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VTab(label: "Tab", icon: VIcon.file.rawValue, onSelect: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Selected").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VTab(label: "Tab", icon: VIcon.file.rawValue, isSelected: true, onSelect: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Not closeable").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VTab(label: "Tab", icon: VIcon.file.rawValue, isCloseable: false, onSelect: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("No icon").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VTab(label: "Plain Tab", isCloseable: false, onSelect: {})
                    }
                }
            }

            // Flat-style tab states
            Text("Tab States (Flat)")
                .font(VFont.headline)
                .foregroundColor(VColor.contentSecondary)

            VCard {
                HStack(spacing: VSpacing.lg) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Default").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VTab(label: "Conversation 1", style: .flat, onSelect: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Selected").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VTab(label: "Conversation 1", isSelected: true, style: .flat, onSelect: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Closeable").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VTab(label: "Conversation 2", style: .flat, onSelect: {}, onClose: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Selected + Closeable").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VTab(label: "Conversation 2", isSelected: true, style: .flat, onSelect: {}, onClose: {})
                    }
                }
            }

            // Rectangular-style tab states
            Text("Tab States (Rectangular)")
                .font(VFont.headline)
                .foregroundColor(VColor.contentSecondary)

            VCard {
                HStack(spacing: VSpacing.lg) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Default").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VTab(label: "Tab", icon: VIcon.file.rawValue, style: .rectangular, onSelect: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Selected").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VTab(label: "Tab", icon: VIcon.file.rawValue, isSelected: true, style: .rectangular, onSelect: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Closeable").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VTab(label: "Tab", icon: VIcon.file.rawValue, style: .rectangular, onSelect: {}, onClose: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Selected + Closeable").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                        VTab(label: "Tab", icon: VIcon.file.rawValue, isSelected: true, style: .rectangular, onSelect: {}, onClose: {})
                    }
                }
            }

        }
    }
}
#endif

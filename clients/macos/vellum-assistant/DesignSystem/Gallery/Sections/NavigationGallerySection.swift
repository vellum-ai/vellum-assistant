#if DEBUG
import SwiftUI

struct NavigationGallerySection: View {
    @State private var segmentSelection = 0
    @State private var selectedTab = 0

    private let segmentItems = ["All", "Active", "Archived", "Drafts"]
    private let tabs = [
        (label: "Dashboard", icon: "house"),
        (label: "Sessions", icon: "list.bullet"),
        (label: "Settings", icon: "gear"),
        (label: "Logs", icon: "doc.text"),
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
                        .foregroundColor(VColor.textMuted)

                    Divider().background(VColor.surfaceBorder)

                    VSegmentedControl(items: segmentItems, selection: $segmentSelection)

                    // Show a placeholder for the selected segment
                    VCard {
                        Text("Content for \"\(segmentItems[segmentSelection])\" tab")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                            .frame(maxWidth: .infinity)
                            .padding(VSpacing.xl)
                    }
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

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
                            .foregroundColor(VColor.textPrimary)
                        Text("Tab content area")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 120)
                    .background(VColor.background)
                }
            }

            // Tab states
            Text("Tab States (Pill)")
                .font(VFont.headline)
                .foregroundColor(VColor.textSecondary)

            VCard {
                HStack(spacing: VSpacing.lg) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Default").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VTab(label: "Tab", icon: "doc", onSelect: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Selected").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VTab(label: "Tab", icon: "doc", isSelected: true, onSelect: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Not closeable").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VTab(label: "Tab", icon: "doc", isCloseable: false, onSelect: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("No icon").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VTab(label: "Plain Tab", isCloseable: false, onSelect: {})
                    }
                }
            }

            // Flat-style tab states
            Text("Tab States (Flat)")
                .font(VFont.headline)
                .foregroundColor(VColor.textSecondary)

            VCard {
                HStack(spacing: VSpacing.lg) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Default").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VTab(label: "Thread 1", style: .flat, onSelect: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Selected").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VTab(label: "Thread 1", isSelected: true, style: .flat, onSelect: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Closeable").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VTab(label: "Thread 2", style: .flat, onSelect: {}, onClose: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Selected + Closeable").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VTab(label: "Thread 2", isSelected: true, style: .flat, onSelect: {}, onClose: {})
                    }
                }
            }

            // Rectangular-style tab states
            Text("Tab States (Rectangular)")
                .font(VFont.headline)
                .foregroundColor(VColor.textSecondary)

            VCard {
                HStack(spacing: VSpacing.lg) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Default").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VTab(label: "Tab", icon: "doc", style: .rectangular, onSelect: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Selected").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VTab(label: "Tab", icon: "doc", isSelected: true, style: .rectangular, onSelect: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Closeable").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VTab(label: "Tab", icon: "doc", style: .rectangular, onSelect: {}, onClose: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Selected + Closeable").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VTab(label: "Tab", icon: "doc", isSelected: true, style: .rectangular, onSelect: {}, onClose: {})
                    }
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - ThreadTab
            GallerySectionHeader(
                title: "ThreadTab",
                description: "Thread-specific tab component. Selected state uses white text with no background or border."
            )

            VCard {
                HStack(spacing: VSpacing.lg) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Default").font(VFont.caption).foregroundColor(VColor.textMuted)
                        ThreadTab(label: "Thread 1", icon: "flame", onSelect: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Selected").font(VFont.caption).foregroundColor(VColor.textMuted)
                        ThreadTab(label: "Thread 1", icon: "flame", isSelected: true, onSelect: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Closeable").font(VFont.caption).foregroundColor(VColor.textMuted)
                        ThreadTab(label: "Thread 2", icon: "flame", onSelect: {}, onClose: {})
                    }
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Selected + Closeable").font(VFont.caption).foregroundColor(VColor.textMuted)
                        ThreadTab(label: "Thread 2", icon: "flame", isSelected: true, onSelect: {}, onClose: {})
                    }
                }
            }
        }
    }
}
#endif

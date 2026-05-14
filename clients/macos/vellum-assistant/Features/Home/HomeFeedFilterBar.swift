import SwiftUI
import VellumAssistantShared

/// Filter pill that mirrors the exact icon rendering used by ``HomeRecapRow``:
/// a 12pt icon inside a 26pt circle with category-specific foreground/background
/// colors. Selected state adds a 2pt ring around the circle.
private struct HomeFeedFilterPill: View {
    let icon: VIcon
    let iconForeground: Color
    let iconBackground: Color
    let isSelected: Bool
    let accessibilityLabel: String
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            ZStack {
                Circle().fill(iconBackground)
                VIconView(icon, size: 12)
                    .foregroundStyle(iconForeground)
            }
            .frame(width: 26, height: 26)
            .opacity(isSelected ? 1.0 : 0.5)
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// Horizontal pill/chip bar that filters the home feed by `FeedItemCategory`.
///
/// Data-driven: only renders pills for categories that have at least one item
/// in the current feed. Each pill uses the same icon, foreground color, and
/// background color as the notification rows in the feed.
struct HomeFeedFilterBar: View {
    let activeFilter: FeedItemCategory?
    let presentCategories: Set<FeedItemCategory>
    let onFilterChanged: (FeedItemCategory?) -> Void

    var body: some View {
        if !presentCategories.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: VSpacing.sm) {
                    HomeFeedFilterPill(
                        icon: .list,
                        iconForeground: VColor.contentSecondary,
                        iconBackground: VColor.surfaceOverlay,
                        isSelected: activeFilter == nil,
                        accessibilityLabel: "All",
                        onTap: { onFilterChanged(nil) }
                    )

                    ForEach(sortedCategories, id: \.self) { category in
                        HomeFeedFilterPill(
                            icon: icon(for: category),
                            iconForeground: iconForeground(for: category),
                            iconBackground: iconBackground(for: category),
                            isSelected: activeFilter == category,
                            accessibilityLabel: category.rawValue.capitalized,
                            onTap: { onFilterChanged(category) }
                        )
                    }
                }
            }
        }
    }

    private var sortedCategories: [FeedItemCategory] {
        FeedItemCategory.allCases.filter { presentCategories.contains($0) }
    }

    private func icon(for category: FeedItemCategory) -> VIcon {
        switch category {
        case .security:   return .shieldCheck
        case .email:      return .mail
        case .scheduling: return .clock
        case .background: return .settings
        case .system:     return .bell
        }
    }

    private func iconForeground(for category: FeedItemCategory) -> Color {
        switch category {
        case .security:   return VColor.feedNudgeStrong
        case .email:      return VColor.feedDigestStrong
        case .scheduling: return VColor.feedThreadStrong
        case .background: return VColor.systemInfoStrong
        case .system:     return VColor.feedDigestStrong
        }
    }

    private func iconBackground(for category: FeedItemCategory) -> Color {
        switch category {
        case .security:   return VColor.feedNudgeWeak
        case .email:      return VColor.feedDigestWeak
        case .scheduling: return VColor.feedThreadWeak
        case .background: return VColor.systemInfoWeak
        case .system:     return VColor.feedDigestWeak
        }
    }
}

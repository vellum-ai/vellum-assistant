import SwiftUI
import VellumAssistantShared

private struct HomeFeedFilterPill: View {
    let icon: VIcon
    let isSelected: Bool
    let accessibilityLabel: String
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VIconView(icon, size: 16)
                .foregroundStyle(isSelected ? VColor.contentInset : VColor.contentSecondary)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xs)
                .background(
                    Capsule()
                        .fill(isSelected ? VColor.primaryBase : Color.clear)
                )
                .overlay(
                    Capsule()
                        .stroke(isSelected ? Color.clear : VColor.borderElement, lineWidth: 1)
                )
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
/// in the current feed. Each pill shows the category's icon instead of text.
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
                        isSelected: activeFilter == nil,
                        accessibilityLabel: "All",
                        onTap: { onFilterChanged(nil) }
                    )

                    ForEach(sortedCategories, id: \.self) { category in
                        HomeFeedFilterPill(
                            icon: icon(for: category),
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
}

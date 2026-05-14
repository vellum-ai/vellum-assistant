import SwiftUI
import VellumAssistantShared

/// A single filter pill rendered inside `HomeFeedFilterBar`. Displays a
/// capitalized category label in either a filled (selected) or ghost/outlined
/// (unselected) style, following the capsule pill pattern established by
/// `HomeSuggestionPill`.
private struct HomeFeedFilterPill: View {
    let label: String
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            Text(label)
                .font(VFont.bodySmallEmphasised)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .foregroundStyle(isSelected ? VColor.contentInset : VColor.contentSecondary)
                .padding(.horizontal, VSpacing.md)
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
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// Horizontal pill/chip bar that filters the home feed by `FeedItemCategory`.
///
/// Data-driven: only renders pills for categories that have at least one item
/// in the current feed. The "All" pill always appears. If only one category
/// (or none) is present, the bar hides entirely since filtering would be
/// meaningless.
struct HomeFeedFilterBar: View {
    let activeFilter: FeedItemCategory?
    let presentCategories: Set<FeedItemCategory>
    let onFilterChanged: (FeedItemCategory?) -> Void

    var body: some View {
        if !presentCategories.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: VSpacing.sm) {
                    HomeFeedFilterPill(
                        label: "All",
                        isSelected: activeFilter == nil,
                        onTap: { onFilterChanged(nil) }
                    )

                    ForEach(sortedCategories, id: \.self) { category in
                        HomeFeedFilterPill(
                            label: category.rawValue.capitalized,
                            isSelected: activeFilter == category,
                            onTap: { onFilterChanged(category) }
                        )
                    }
                }
            }
        }
    }

    /// Stable ordering so pills don't jump around as items arrive.
    private var sortedCategories: [FeedItemCategory] {
        FeedItemCategory.allCases.filter { presentCategories.contains($0) }
    }
}

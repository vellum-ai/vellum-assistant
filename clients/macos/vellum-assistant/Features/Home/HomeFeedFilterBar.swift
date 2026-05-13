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
/// Renders an "All" pill (selected by default when `activeFilter` is nil)
/// followed by one pill per `FeedItemCategory` case. The parent owns the
/// filter state and passes it down; tapping a pill fires `onFilterChanged`
/// with the new selection (nil for "All").
struct HomeFeedFilterBar: View {
    let activeFilter: FeedItemCategory?
    let onFilterChanged: (FeedItemCategory?) -> Void

    /// Display labels derived from `FeedItemCategory` raw values.
    private static let categories: [(label: String, category: FeedItemCategory)] =
        FeedItemCategory.allCases.map { category in
            (label: category.rawValue.capitalized, category: category)
        }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: VSpacing.sm) {
                HomeFeedFilterPill(
                    label: "All",
                    isSelected: activeFilter == nil,
                    onTap: { onFilterChanged(nil) }
                )

                ForEach(Self.categories, id: \.category) { entry in
                    HomeFeedFilterPill(
                        label: entry.label,
                        isSelected: activeFilter == entry.category,
                        onTap: { onFilterChanged(entry.category) }
                    )
                }
            }
        }
    }
}

import SwiftUI
import VellumAssistantShared

/// Generic section component for the home feed. Displays a header,
/// a capped list of compact rows, and an expand/collapse toggle.
struct HomeSectionView: View {
    let title: String
    let items: [FeedItem]
    let cap: Int

    @State private var isExpanded = false

    var body: some View {
        let visibleItems = isExpanded ? items : Array(items.prefix(cap))
        let hasOverflow = items.count > cap

        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Section header
            Text(title)
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentTertiary)
                .accessibilityAddTraits(.isHeader)
                .padding(.leading, VSpacing.xs)

            // Compact rows
            ForEach(visibleItems) { item in
                HomeSectionRow(item: item)
            }

            // Show more / Show less toggle
            if hasOverflow {
                Button {
                    withAnimation(VAnimation.fast) {
                        isExpanded.toggle()
                    }
                } label: {
                    Text(isExpanded ? "Show less" : "Show more (\(items.count - cap))")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.primaryBase)
                }
                .buttonStyle(.plain)
                .padding(.leading, VSpacing.xs)
                .accessibilityLabel(isExpanded ? "Show less items" : "Show \(items.count - cap) more items")
            }
        }
    }
}

// MARK: - Compact Row

/// A single compact row within a home feed section.
private struct HomeSectionRow: View {
    let item: FeedItem

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            Circle()
                .fill(item.status == .new ? VColor.primaryBase : VColor.contentDisabled)
                .frame(width: 6, height: 6)

            Text(item.title)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)

            Spacer(minLength: 0)

            if let source = item.source {
                Text(source)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .lineLimit(1)
            }
        }
        .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.sm, bottom: VSpacing.xs, trailing: VSpacing.sm))
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceLift)
        )
        .accessibilityElement(children: .combine)
    }
}

import SwiftUI

/// Ensures content is at least `minHeight` tall, pinning the child to the
/// bottom edge when the child is shorter than the minimum. Drop-in replacement
/// for `.frame(minHeight:alignment: .bottom)` that avoids `_FlexFrameLayout`
/// and its O(n x depth) `explicitAlignment` cascade inside LazyVStack cells.
///
/// `_FlexFrameLayout` resolves `.bottom` alignment by calling
/// `explicitAlignment(.bottom)` on every descendant, which propagates
/// recursively through the entire subtree. This Layout-protocol
/// implementation achieves the same visual result in O(1) by positioning
/// the child via `placeSubviews` — no alignment query cascade.
///
/// Reference: [Layout.explicitAlignment](https://developer.apple.com/documentation/swiftui/layout/explicitalignment(of:in:proposal:subviews:cache:)-8ofeu)
struct BottomAlignedMinHeightLayout: Layout {
    let minHeight: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else {
            return CGSize(width: proposal.replacingUnspecifiedDimensions().width, height: minHeight)
        }
        let childSize = child.sizeThatFits(proposal)
        return CGSize(
            width: childSize.width,
            height: max(childSize.height, minHeight)
        )
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let child = subviews.first else { return }
        let childSize = child.sizeThatFits(
            ProposedViewSize(width: bounds.width, height: bounds.height)
        )
        // Pin child to bottom of bounds (same as alignment: .bottom).
        let y = bounds.maxY - childSize.height
        child.place(
            at: CGPoint(x: bounds.origin.x, y: y),
            anchor: .topLeading,
            proposal: ProposedViewSize(width: bounds.width, height: bounds.height)
        )
    }
}

extension View {
    /// Applies a minimum height with bottom alignment without creating
    /// `_FlexFrameLayout`. When `minHeight` is nil, no constraint is applied.
    @ViewBuilder
    func bottomAlignedMinHeight(_ minHeight: CGFloat?) -> some View {
        if let minHeight {
            BottomAlignedMinHeightLayout(minHeight: minHeight) { self }
        } else {
            self
        }
    }
}

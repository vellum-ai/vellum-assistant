import SwiftUI

/// Ensures content is at least `minHeight` tall, vertically centering the
/// child when it is shorter than the minimum. Drop-in replacement for
/// `.frame(minHeight:)` (default `alignment: .center`) that avoids
/// `_FlexFrameLayout` and its `explicitAlignment` cascade.
///
/// `_FlexFrameLayout` resolves `.center` alignment by recursively querying
/// every descendant's alignment guides — O(n × depth) per layout pass. This
/// `Layout`-protocol implementation positions the child via `placeSubviews`
/// and returns `nil` from `explicitAlignment`, blocking the cascade in O(1).
///
/// Reference: [Layout.explicitAlignment](https://developer.apple.com/documentation/swiftui/layout/explicitalignment(of:in:proposal:subviews:cache:)-8ofeu)
public struct CenterAlignedMinHeightLayout: Layout {
    public let minHeight: CGFloat

    public init(minHeight: CGFloat) {
        self.minHeight = minHeight
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else {
            return CGSize(width: proposal.replacingUnspecifiedDimensions().width, height: minHeight)
        }
        let childSize = child.sizeThatFits(proposal)
        return CGSize(
            width: childSize.width,
            height: max(childSize.height, minHeight)
        )
    }

    public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let child = subviews.first else { return }
        // Re-measure with the SAME proposal that sizeThatFits received.
        // Using bounds.height would propose the expanded min-height to the
        // child, which can return a different size than during measurement
        // — causing SwiftUI to detect a layout inconsistency and
        // re-evaluate the layout every frame.
        let childSize = child.sizeThatFits(proposal)
        // Vertically center child within bounds (same as default
        // `.frame(minHeight:)` alignment of `.center`).
        let y = bounds.midY - childSize.height / 2
        child.place(
            at: CGPoint(x: bounds.origin.x, y: y),
            anchor: .topLeading,
            proposal: ProposedViewSize(width: childSize.width, height: childSize.height)
        )
    }

    // MARK: - Alignment (opt out of default cascade)

    /// Returns `nil` to opt out of the default guide-merging cascade.
    ///
    /// The default `Layout` protocol implementation iterates every subview
    /// and recursively queries their alignment guides — O(n × depth).
    /// Returning `nil` tells ancestors "no explicit guide value; use default
    /// positioning", which is correct because this layout positions its
    /// child via `placeSubviews`, not alignment guides.
    ///
    /// Reference: [Layout.explicitAlignment](https://developer.apple.com/documentation/swiftui/layout/explicitalignment(of:in:proposal:subviews:cache:)-8ofeu)
    public func explicitAlignment(of guide: HorizontalAlignment, in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGFloat? {
        nil
    }

    public func explicitAlignment(of guide: VerticalAlignment, in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGFloat? {
        nil
    }
}

extension View {
    /// Applies a minimum height with center alignment without creating
    /// `_FlexFrameLayout`. When `minHeight` is nil, no constraint is applied.
    @ViewBuilder
    public func centerAlignedMinHeight(_ minHeight: CGFloat?) -> some View {
        if let minHeight {
            CenterAlignedMinHeightLayout(minHeight: minHeight) { self }
        } else {
            self
        }
    }
}

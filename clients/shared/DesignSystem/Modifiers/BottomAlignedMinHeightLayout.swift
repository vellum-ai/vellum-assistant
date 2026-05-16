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
public struct BottomAlignedMinHeightLayout: Layout {
    public let minHeight: CGFloat

    public init(minHeight: CGFloat) {
        self.minHeight = minHeight
    }

    public func makeCache(subviews: Subviews) -> SingleSubviewLayoutCache {
        SingleSubviewLayoutCache()
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout SingleSubviewLayoutCache) -> CGSize {
        guard let child = subviews.first else {
            return CGSize(width: proposal.replacingUnspecifiedDimensions().width, height: minHeight)
        }
        let childSize = child.sizeThatFits(proposal)
        cache.store(proposal: proposal, childSize: childSize)
        return CGSize(
            width: childSize.width,
            height: max(childSize.height, minHeight)
        )
    }

    public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout SingleSubviewLayoutCache) {
        guard let child = subviews.first else { return }
        // Reuse the measurement from sizeThatFits. Falling back to the same
        // proposal preserves layout consistency without forcing a second
        // transcript-wide measurement during placement.
        let childSize = cache.childSize(for: proposal) {
            child.sizeThatFits(proposal)
        }
        // Pin child to bottom of bounds (same as alignment: .bottom).
        let y = bounds.maxY - childSize.height
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
    /// and recursively queries their alignment guides — O(n × depth). When
    /// this layout wraps the entire LazyVStack scroll content, the cascade
    /// walks every visible cell, producing multi-second hangs.
    ///
    /// Returning `nil` tells ancestors "no explicit guide value; use default
    /// positioning", which is correct because this layout positions its
    /// child via `placeSubviews`, not alignment guides.
    ///
    /// Reference: [Layout.explicitAlignment](https://developer.apple.com/documentation/swiftui/layout/explicitalignment(of:in:proposal:subviews:cache:)-8ofeu)
    public func explicitAlignment(of guide: HorizontalAlignment, in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout SingleSubviewLayoutCache) -> CGFloat? {
        nil
    }

    public func explicitAlignment(of guide: VerticalAlignment, in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout SingleSubviewLayoutCache) -> CGFloat? {
        nil
    }
}

extension View {
    /// Applies a minimum height with bottom alignment without creating
    /// `_FlexFrameLayout`. When `minHeight` is nil, no constraint is applied.
    @ViewBuilder
    public func bottomAlignedMinHeight(_ minHeight: CGFloat?) -> some View {
        if let minHeight {
            BottomAlignedMinHeightLayout(minHeight: minHeight) { self }
        } else {
            self
        }
    }
}

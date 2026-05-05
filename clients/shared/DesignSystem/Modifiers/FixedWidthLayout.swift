import SwiftUI

/// Sets a definite width using the Layout protocol (O(1)).
/// Drop-in replacement for `.frame(width: N)` that avoids `_FrameLayout`'s
/// alignment cascade through `placeSubviews`.
///
/// `.frame(width:)` creates `_FrameLayout` whose `sizeThatFits` returns
/// the fixed width in O(1) — but during `placeSubviews`, its
/// `commonPlacement` reads `ViewDimensions[guide]` to position the child,
/// which triggers `explicitAlignment` on the child subtree. Inside a
/// `LazyVStack`, this cascades through every visible cell at
/// O(n x depth), causing multi-second hangs (3,200+ events in Sentry).
///
/// This Layout achieves the same sizing result without the alignment
/// cascade: `placeSubviews` places the child at the origin with a
/// `.topLeading` anchor — no alignment query — and both
/// `explicitAlignment` overloads return `nil` to stop any parent-
/// initiated cascade.
///
/// Reference: [Layout.explicitAlignment](https://developer.apple.com/documentation/swiftui/layout/explicitalignment(of:in:proposal:subviews:cache:)-8ofeu)
public struct FixedWidthLayout: Layout {
    let width: CGFloat

    public init(width: CGFloat) {
        self.width = width
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return CGSize(width: width, height: 0) }
        let childSize = child.sizeThatFits(ProposedViewSize(width: width, height: proposal.height))
        return CGSize(width: width, height: childSize.height)
    }

    public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let child = subviews.first else { return }
        child.place(
            at: bounds.origin,
            anchor: .topLeading,
            proposal: ProposedViewSize(width: bounds.width, height: bounds.height)
        )
    }

    // MARK: - Alignment (opt out of default cascade)

    /// Returns `nil` to opt out of the default guide-merging cascade.
    ///
    /// The default `Layout` protocol implementation iterates every subview
    /// and recursively queries their alignment guides — O(n x depth).
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
    /// Sets a definite width without creating `_FrameLayout`.
    /// When `width` is nil, no constraint is applied.
    @ViewBuilder
    public func fixedWidth(_ width: CGFloat?) -> some View {
        if let width {
            FixedWidthLayout(width: width) { self }
        } else {
            self
        }
    }
}

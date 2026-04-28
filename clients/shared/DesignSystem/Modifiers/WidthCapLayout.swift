import SwiftUI

/// Caps proposed width at a maximum value using the Layout protocol (O(1)).
/// Drop-in replacement for `.frame(maxWidth: N)` that avoids
/// `_FlexFrameLayout` and its O(n × depth) `explicitAlignment` cascade
/// inside LazyVStack cells.
///
/// Reference: [Layout.explicitAlignment](https://developer.apple.com/documentation/swiftui/layout/explicitalignment(of:in:proposal:subviews:cache:)-8ofeu)
public struct WidthCapLayout: Layout {
    let cap: CGFloat

    public init(cap: CGFloat) {
        self.cap = cap
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let available = proposal.replacingUnspecifiedDimensions().width
        let width = min(cap, available)
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
    /// Caps width at `cap` without creating `_FlexFrameLayout`.
    /// When `cap` is nil, no constraint is applied.
    @ViewBuilder
    public func widthCap(_ cap: CGFloat?) -> some View {
        if let cap {
            WidthCapLayout(cap: cap) { self }
        } else {
            self
        }
    }
}

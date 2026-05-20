import SwiftUI

/// Passthrough layout that blocks the `explicitAlignment` cascade without
/// modifying sizing or placement. Drop-in wrapper for subtrees inside
/// LazyVStack cells where nested VStacks cause O(n × depth) alignment
/// queries during trial placement.
///
/// VStack's internal layout (`sizeChildrenGenerallyWithConcreteMajorProposal`)
/// queries `explicitAlignment` on every child during trial placement, even
/// for `.leading` alignment where the result is always x = 0. When VStacks
/// are nested (e.g. PinnedLatestTurnSection → responseCluster → ChatBubble),
/// the cascade recurses through every level, producing O(N × depth) work
/// per layout pass.
///
/// This layout wraps a subtree so parent stacks receive `nil` from
/// `explicitAlignment` — "no explicit guide; use default positioning" —
/// cutting the cascade at O(1). Sizing and placement pass through to the
/// child unchanged.
///
/// Reference: [Layout.explicitAlignment](https://developer.apple.com/documentation/swiftui/layout/explicitalignment(of:in:proposal:subviews:cache:)-8ofeu)
public struct AlignmentBarrierLayout: Layout {
    public init() {}

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        subviews.first?.sizeThatFits(proposal) ?? .zero
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
    /// Wraps the view in an alignment barrier that blocks `explicitAlignment`
    /// cascade from ancestor stacks. Sizing and placement pass through
    /// unchanged.
    public func alignmentBarrier() -> some View {
        AlignmentBarrierLayout() { self }
    }
}

import SwiftUI

/// Caches the last child measurement for single-child `Layout` wrappers.
///
/// SwiftUI normally calls `sizeThatFits` before `placeSubviews` with the same
/// proposal. Reusing that measurement avoids a second walk through expensive
/// descendants such as chat transcript `LazyVStack`s.
public struct SingleSubviewLayoutCache {
    private var proposalWidth: CGFloat?
    private var proposalHeight: CGFloat?
    private var childSize: CGSize?

    public init() {}

    mutating func store(proposal: ProposedViewSize, childSize: CGSize) {
        proposalWidth = proposal.width
        proposalHeight = proposal.height
        self.childSize = childSize
    }

    mutating func childSize(for proposal: ProposedViewSize, measuring measure: () -> CGSize) -> CGSize {
        if proposalWidth == proposal.width,
           proposalHeight == proposal.height,
           let childSize {
            return childSize
        }

        let measured = measure()
        store(proposal: proposal, childSize: measured)
        return measured
    }
}

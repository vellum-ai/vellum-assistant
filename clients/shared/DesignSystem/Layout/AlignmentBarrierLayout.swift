import SwiftUI

/// Blocks `explicitAlignment` queries from cascading into its subtree.
///
/// When a parent `_FlexFrameLayout` (created by `.frame(maxWidth:, alignment:)`)
/// queries a child's explicit alignment, the query recurses through every
/// descendant that also has a FlexFrame — O(depth × children) per layout pass.
/// Inside a `LazyVStack`, this triggers `measureEstimates` on ALL cells,
/// causing multi-second main-thread hangs.
///
/// `AlignmentBarrierLayout` returns `nil` for both horizontal and vertical
/// alignment queries, stopping the cascade at the barrier. Sizing and
/// placement pass through unchanged — only the alignment query is blocked.
///
/// Place this between any external FlexFrame and the `LazyVStack` to prevent
/// alignment queries from reaching the lazy container.
///
/// - SeeAlso: [Layout protocol](https://developer.apple.com/documentation/swiftui/layout)
/// - SeeAlso: [WWDC23: Demystify SwiftUI performance](https://developer.apple.com/videos/play/wwdc2023/10160/)
/// - SeeAlso: [ViewDimensions.subscript](https://developer.apple.com/documentation/swiftui/viewdimensions)
public struct AlignmentBarrierLayout: Layout {
    public init() {}

    public func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        subviews.first?.sizeThatFits(proposal) ?? .zero
    }

    public func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        subviews.first?.place(at: bounds.origin, proposal: proposal)
    }

    public func explicitAlignment(
        of guide: HorizontalAlignment,
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGFloat? {
        nil
    }

    public func explicitAlignment(
        of guide: VerticalAlignment,
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGFloat? {
        nil
    }
}

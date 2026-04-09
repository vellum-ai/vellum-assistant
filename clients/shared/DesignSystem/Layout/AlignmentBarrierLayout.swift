import SwiftUI

/// Blocks [`explicitAlignment`](https://developer.apple.com/documentation/swiftui/layout/explicitalignment(of:in:proposal:subviews:cache:)-3iqmu)
/// queries from cascading into its subtree. Returns `nil` for both horizontal
/// and vertical alignment guides while passing sizing and placement through unchanged.
///
/// Place between any `.frame(maxWidth:, alignment:)` and a `LazyVStack` to
/// prevent O(depth × children) recursive alignment measurement.
///
/// - SeeAlso: [WWDC23 – Demystify SwiftUI performance](https://developer.apple.com/videos/play/wwdc2023/10160/)
/// - SeeAlso: [`ViewDimensions`](https://developer.apple.com/documentation/swiftui/viewdimensions)
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

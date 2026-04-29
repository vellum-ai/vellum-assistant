import SwiftUI

/// Type-erased `InsettableShape` enabling runtime shape switching while
/// preserving `strokeBorder` support (which requires `InsettableShape`).
public struct AnyInsettableShape: InsettableShape {
    private let _path: @Sendable (CGRect) -> Path
    private let _sizeThatFits: @Sendable (ProposedViewSize) -> CGSize
    private let _inset: @Sendable (CGFloat) -> AnyInsettableShape

    public init<S: InsettableShape>(_ shape: S) {
        _path = { shape.path(in: $0) }
        _sizeThatFits = { shape.sizeThatFits($0) }
        _inset = { AnyInsettableShape(shape.inset(by: $0)) }
    }

    public func path(in rect: CGRect) -> Path { _path(rect) }
    public func sizeThatFits(_ proposal: ProposedViewSize) -> CGSize { _sizeThatFits(proposal) }
    public func inset(by amount: CGFloat) -> AnyInsettableShape { _inset(amount) }
}

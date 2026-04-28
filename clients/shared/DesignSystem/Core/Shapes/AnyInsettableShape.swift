import SwiftUI

/// Type-erased `InsettableShape` enabling runtime shape switching while
/// preserving `strokeBorder` support (which requires `InsettableShape`).
public struct AnyInsettableShape: InsettableShape {
    private let _path: (CGRect) -> Path
    private let _sizeThatFits: (ProposedViewSize) -> CGSize
    private let _inset: (CGFloat) -> AnyInsettableShape

    public init<S: InsettableShape>(_ shape: S) {
        _path = shape.path
        _sizeThatFits = shape.sizeThatFits
        _inset = { AnyInsettableShape(shape.inset(by: $0)) }
    }

    public func path(in rect: CGRect) -> Path { _path(rect) }
    public func sizeThatFits(_ proposal: ProposedViewSize) -> CGSize { _sizeThatFits(proposal) }
    public func inset(by amount: CGFloat) -> AnyInsettableShape { _inset(amount) }
}

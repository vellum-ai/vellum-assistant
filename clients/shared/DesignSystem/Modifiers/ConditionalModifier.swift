import SwiftUI

public extension View {
    /// Conditionally applies a transformation to a view.
    ///
    /// When the condition is `true`, the `transform` closure is applied;
    /// otherwise the view is returned unchanged.
    @ViewBuilder
    func `if`<Content: View>(_ condition: Bool, transform: (Self) -> Content) -> some View {
        if condition {
            transform(self)
        } else {
            self
        }
    }
}

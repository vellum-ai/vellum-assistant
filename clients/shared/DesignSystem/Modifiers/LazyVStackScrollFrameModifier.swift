import SwiftUI

extension View {
    /// Applies a definite height to a `ScrollView` inside a `LazyVStack` cell so
    /// `LazyVStack` can skip scroll-content measurement during cell sizing.
    ///
    /// Without a definite `frame(height:)`, `LazyVStack` passes an `.unset` height
    /// proposal through `_FlexFrameLayout`, triggering a full content measurement
    /// that can hang for tens of seconds on very long text.
    ///
    /// - Parameter height: The fixed height applied to the ScrollView.
    func vAdaptiveScrollFrame(height: CGFloat) -> some View {
        self.frame(height: height)
    }
}

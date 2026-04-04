import SwiftUI

extension View {
    /// Applies an adaptive height constraint to a `ScrollView` inside a `LazyVStack` cell.
    ///
    /// When `isLong` is `true`, a definite `frame(height:)` is applied so `LazyVStack` can
    /// skip scroll-content measurement during cell sizing. When `false`, `frame(maxHeight:)`
    /// lets the view collapse to its natural height instead of rendering with blank space.
    ///
    /// Callers are responsible for computing and caching the `isLong` decision (e.g. via
    /// `@State` or a cached line count) to avoid redundant O(n) string scans on every render.
    ///
    /// - Parameters:
    ///   - isLong: Whether the content exceeds the threshold for fixed-height treatment.
    ///   - maxHeight: The height cap applied in both branches.
    func vAdaptiveScrollFrame(
        isLong: Bool,
        maxHeight: CGFloat
    ) -> some View {
        self
            .frame(height: isLong ? maxHeight : nil)
            .frame(maxHeight: isLong ? nil : maxHeight)
    }
}

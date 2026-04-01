import SwiftUI

public extension View {
    /// Platform-appropriate text selection for inline SwiftUI `Text` views.
    ///
    /// - **iOS / visionOS:** Applies `.textSelection(.enabled)` normally.
    /// - **macOS:** No-op. SwiftUI's `.textSelection(.enabled)` creates a
    ///   private `SelectionOverlay` `NSViewRepresentable` per view, which
    ///   triggers an expensive `NSTextFieldCell` font/bezel cascade during
    ///   view graph updates on macOS 26 (2 s+ main-thread hangs when many
    ///   instances exist in a `LazyVStack`). Use ``VSelectableTextView``
    ///   instead for macOS text that must remain natively selectable.
    ///
    /// Reference: LUM-615
    @ViewBuilder
    func textSelectionIfAvailable() -> some View {
        #if os(macOS)
        self
        #else
        self.textSelection(.enabled)
        #endif
    }
}

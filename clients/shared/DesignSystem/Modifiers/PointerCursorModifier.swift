import SwiftUI

/// A view modifier that shows a pointing-hand (link) cursor on hover.
///
/// Uses the native `.pointerStyle(.link)` SwiftUI modifier on macOS.
///
/// Respects the SwiftUI disabled state: when the view is disabled via `.disabled(true)`,
/// the pointer cursor is suppressed.
///
/// Accepts an optional `onHover` callback so callers can consolidate hover tracking
/// into a single `.onHover` handler, avoiding competing hover registrations.
struct PointerCursorModifier: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled
    var onHover: ((Bool) -> Void)?

    func body(content: Content) -> some View {
        #if os(macOS)
        content
            .pointerStyle(isEnabled ? .link : nil)
            .onHover { hovering in
                onHover?(hovering)
            }
        #else
        content
            .onHover { hovering in
                onHover?(hovering)
            }
        #endif
    }
}

public extension View {
    /// Applies a pointing-hand cursor when the user hovers over this view.
    func pointerCursor() -> some View {
        modifier(PointerCursorModifier())
    }

    /// Applies a pointing-hand cursor and calls `onHover` in a single hover handler.
    func pointerCursor(onHover: @escaping (Bool) -> Void) -> some View {
        modifier(PointerCursorModifier(onHover: onHover))
    }
}


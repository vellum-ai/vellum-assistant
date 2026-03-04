import SwiftUI

#if os(macOS)
import AppKit
#endif

/// A view modifier that shows a pointing-hand (link) cursor on hover.
///
/// On macOS 15+ this uses the native `.pointerStyle(.link)` SwiftUI modifier.
/// On macOS 14 it falls back to `NSCursor.pointingHand.push()` / `NSCursor.pop()`.
struct PointerCursorModifier: ViewModifier {
    #if os(macOS)
    @State private var isHovered = false
    #endif

    func body(content: Content) -> some View {
        #if os(macOS)
        if #available(macOS 15.0, *) {
            content
                .pointerStyle(.link)
        } else {
            content
                .onHover { hovering in
                    isHovered = hovering
                    if hovering {
                        NSCursor.pointingHand.push()
                    } else {
                        NSCursor.pop()
                    }
                }
                .onDisappear {
                    if isHovered {
                        NSCursor.pop()
                    }
                }
        }
        #else
        content
        #endif
    }
}

public extension View {
    /// Applies a pointing-hand cursor when the user hovers over this view.
    func pointerCursor() -> some View {
        modifier(PointerCursorModifier())
    }
}

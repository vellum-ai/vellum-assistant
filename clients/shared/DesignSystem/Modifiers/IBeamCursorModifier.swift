import SwiftUI

#if os(macOS)
import AppKit
#endif

/// A view modifier that shows an I-beam (text) cursor on hover.
///
/// On macOS 15+ this uses the native `.pointerStyle(.horizontalBeamResize)` workaround
/// since there is no `.iBeam` pointer style. On macOS 14 it falls back to
/// `NSCursor.iBeam.push()` / `NSCursor.pop()`.
struct IBeamCursorModifier: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled

    #if os(macOS)
    @State private var didPushCursor = false
    #endif

    func body(content: Content) -> some View {
        #if os(macOS)
        content
            .onHover { hovering in
                if hovering && isEnabled {
                    NSCursor.iBeam.push()
                    didPushCursor = true
                } else if didPushCursor {
                    NSCursor.pop()
                    didPushCursor = false
                }
            }
            .onChange(of: isEnabled) { _, enabled in
                if !enabled && didPushCursor {
                    NSCursor.pop()
                    didPushCursor = false
                }
            }
            .onDisappear {
                if didPushCursor {
                    NSCursor.pop()
                    didPushCursor = false
                }
            }
        #else
        content
        #endif
    }
}

extension View {
    /// Applies an I-beam (text) cursor when the user hovers over this view.
    func iBeamCursor() -> some View {
        modifier(IBeamCursorModifier())
    }
}

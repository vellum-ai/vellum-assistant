import SwiftUI

#if os(macOS)
import AppKit
#endif

/// A view modifier that shows a pointing-hand (link) cursor on hover.
///
/// On macOS 15+ this uses the native `.pointerStyle(.link)` SwiftUI modifier.
/// On macOS 14 it falls back to `NSCursor.pointingHand.push()` / `NSCursor.pop()`.
///
/// Respects the SwiftUI disabled state: when the view is disabled via `.disabled(true)`,
/// the pointer cursor is suppressed.
struct PointerCursorModifier: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled

    #if os(macOS)
    @State private var didPushCursor = false
    #endif

    func body(content: Content) -> some View {
        #if os(macOS)
        if #available(macOS 15.0, *) {
            content
                .pointerStyle(isEnabled ? .link : nil)
        } else {
            content
                .onHover { hovering in
                    if hovering && isEnabled {
                        NSCursor.pointingHand.push()
                        didPushCursor = true
                    } else if didPushCursor {
                        NSCursor.pop()
                        didPushCursor = false
                    }
                }
                .onChange(of: isEnabled) { enabled in
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

#Preview("PointerCursorModifier") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: VSpacing.lg) {
            Text("Hover over the button to see the pointer cursor")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)

            Button("Clickable item") {}
                .buttonStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.md)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .pointerCursor()

            Text("Regular text (no pointer)")
                .font(VFont.body)
                .foregroundColor(VColor.textMuted)
        }
        .padding()
    }
    .frame(width: 300, height: 200)
}

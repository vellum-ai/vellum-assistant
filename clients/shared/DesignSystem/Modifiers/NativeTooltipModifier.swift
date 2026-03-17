import SwiftUI

#if os(macOS)
import AppKit

/// Sets `NSView.toolTip` directly via AppKit, bypassing SwiftUI's `.help()` modifier.
///
/// SwiftUI's `.help()` relies on the same event system as gesture recognizers.
/// In views with complex gesture hierarchies (`.onTapGesture` + `.contextMenu`
/// + `.onDrag` + `.onHover`), `.help()` tooltips may never fire because the
/// competing tracking areas consume the idle-mouse events that the tooltip
/// system depends on.
///
/// This modifier uses AppKit's `NSView.toolTip` via `.background()`, which
/// tracks mouse idle at the window level independently of SwiftUI gestures.
/// This is the standard recommended workaround for `.help()` reliability issues
/// on macOS.
private struct NativeTooltipView: NSViewRepresentable {
    let text: String

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.toolTip = text
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        nsView.toolTip = text
    }
}

public extension View {
    /// Attaches a native macOS tooltip via AppKit's `NSView.toolTip`.
    ///
    /// Prefer `.help()` for simple views. Use this modifier in views where
    /// SwiftUI gesture recognizers (`.onTapGesture`, `.contextMenu`, `.onDrag`)
    /// prevent `.help()` tooltips from appearing.
    func nativeTooltip(_ text: String) -> some View {
        self.background(NativeTooltipView(text: text))
    }
}
#else
public extension View {
    /// On non-macOS platforms, falls back to the standard `.help()` modifier.
    func nativeTooltip(_ text: String) -> some View {
        self.help(text)
    }
}
#endif

import SwiftUI
#if os(macOS)
import AppKit
#endif

/// Utilities for managing the app's light/dark appearance.
public enum VTheme {
    /// Apply the selected theme preference to the app's appearance.
    public static func applyTheme(_ preference: String) {
        #if os(macOS)
        let appearance: NSAppearance?
        switch preference {
        case "light":
            appearance = NSAppearance(named: .aqua)
        case "dark":
            appearance = NSAppearance(named: .darkAqua)
        default:
            appearance = nil
        }
        NSApp.appearance = appearance
        for window in NSApp.windows {
            window.appearance = appearance
            window.invalidateShadow()
            window.contentView?.needsDisplay = true
        }
        #endif
    }
}

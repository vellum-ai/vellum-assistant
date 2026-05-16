import SwiftUI
#if os(macOS)
import AppKit
#endif

/// Utilities for managing the app's light/dark/velvet appearance.
public enum VTheme {
    /// Whether velvet mode is currently active. Color token dynamic providers
    /// read this at resolution time to select velvet-specific values.
    public private(set) static var isVelvet: Bool = false

    /// Apply the selected theme preference to the app's appearance.
    /// If ``velvet`` is requested but the `velvet-theme` feature flag is off,
    /// falls back to standard dark mode to prevent stale preferences from
    /// bypassing rollout control.
    public static func applyTheme(_ preference: String) {
        #if os(macOS)
        let effective = (preference == "velvet" && !MacOSClientFeatureFlagManager.shared.isEnabled("velvet-theme"))
            ? "dark"
            : preference
        let appearance: NSAppearance?
        switch effective {
        case "light":
            appearance = NSAppearance(named: .aqua)
            isVelvet = false
        case "dark":
            appearance = NSAppearance(named: .darkAqua)
            isVelvet = false
        case "velvet":
            appearance = NSAppearance(named: .darkAqua)
            isVelvet = true
        default:
            appearance = nil
            isVelvet = false
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

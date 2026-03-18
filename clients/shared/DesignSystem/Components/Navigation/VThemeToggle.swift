import SwiftUI
#if os(macOS)
import AppKit
#endif

/// Compact three-way theme toggle (System / Light / Dark) using pill-style icons.
///
/// Reads and writes the `themePreference` key in `UserDefaults` and applies the
/// selected appearance app-wide on macOS. Drop this into any view that needs a
/// theme switcher — the gallery sidebar, control center drawer, settings, etc.
public struct VThemeToggle: View {
    @AppStorage("themePreference") private var themePreference: String = "system"

    public init() {}

    public var body: some View {
        HStack(spacing: VSpacing.xs) {
            Text("Theme")
                .font(VFont.caption)
                .foregroundColor(VColor.contentDisabled)
            Spacer()
            VSegmentedControl(
                items: [
                    (label: "System", icon: VIcon.monitor.rawValue, tag: "system"),
                    (label: "Light", icon: VIcon.sun.rawValue, tag: "light"),
                    (label: "Dark", icon: VIcon.moon.rawValue, tag: "dark"),
                ],
                selection: Binding(
                    get: { themePreference },
                    set: {
                        themePreference = $0
                        Self.applyTheme($0)
                    }
                ),
                style: .pill
            )
            .fixedSize()
        }
    }

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

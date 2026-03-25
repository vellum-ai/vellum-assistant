import SwiftUI
#if os(macOS)
import AppKit
#endif

/// Display style for the theme toggle.
public enum VThemeToggleStyle {
    /// Icon-only pill segments (monitor / sun / moon). Compact — ideal for sidebars and drawers.
    case iconPill
    /// Text-label pill segments ("System" / "Light" / "Dark"). Used in settings forms.
    case labelPill
}

/// Three-way theme toggle (System / Light / Dark) using pill-style segments.
///
/// Reads and writes the `themePreference` key in `UserDefaults` and applies the
/// selected appearance app-wide on macOS.
public struct VThemeToggle: View {
    @AppStorage("themePreference") private var themePreference: String = "system"

    private let style: VThemeToggleStyle
    private let showLabel: Bool

    /// - Parameters:
    ///   - style: `.iconPill` (default) for icon-only segments, `.labelPill` for text labels.
    ///   - showLabel: Whether to show the "Theme" label to the left. Defaults to `true`.
    public init(style: VThemeToggleStyle = .iconPill, showLabel: Bool = true) {
        self.style = style
        self.showLabel = showLabel
    }

    public var body: some View {
        HStack(spacing: VSpacing.xs) {
            if showLabel {
                Text("Theme")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDisabled)
                Spacer()
            }
            segmentedControl
        }
    }

    /// Fixed width of the pill control, sized so segments divide equally
    /// (icon segments are square, label segments are equal-width rectangles).
    private var pillWidth: CGFloat {
        switch style {
        case .iconPill:  return 104
        case .labelPill: return 248
        }
    }

    @ViewBuilder
    private var segmentedControl: some View {
        switch style {
        case .iconPill:
            VTabs(
                items: [
                    (label: "System", icon: VIcon.monitor.rawValue, tag: "system"),
                    (label: "Light", icon: VIcon.sun.rawValue, tag: "light"),
                    (label: "Dark", icon: VIcon.moon.rawValue, tag: "dark"),
                ],
                selection: themeBinding,
                style: .pill
            )
            .frame(width: pillWidth)
        case .labelPill:
            VTabs(
                items: [
                    (label: "System", tag: "system"),
                    (label: "Light", tag: "light"),
                    (label: "Dark", tag: "dark"),
                ],
                selection: themeBinding,
                style: .pill
            )
            .frame(width: pillWidth)
        }
    }

    private var themeBinding: Binding<String> {
        Binding(
            get: { themePreference },
            set: {
                themePreference = $0
                Self.applyTheme($0)
            }
        )
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

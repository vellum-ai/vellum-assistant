import SwiftUI
import UIKit

/// The one palette the Vellum Home Screen widgets draw from.
///
/// A widget renders in a process that never runs the SPA, so the CSS custom
/// properties the rest of the product themes itself with cannot reach it, and
/// `CSSHexColor` solves a different problem: it parses colors the web layer
/// *hands across* at runtime, and nothing hands a widget anything. The values
/// are therefore literals, collected here rather than spelled at each use so
/// the widgets cannot drift into three slightly different greens.
///
/// Every entry carries a dark variant, resolved per render from the trait
/// collection. A Home Screen widget is drawn in whatever appearance the device
/// is in, and a white card on a dark Home Screen would be the brightest thing
/// on the display.
enum WidgetTheme {
    /// The card the whole widget sits on, passed to `containerBackground`.
    static let surface = dynamic(light: "#FFFFFF", dark: "#1C1C1E")

    /// Fill behind the New Chat action, tinted toward the brand green.
    static let newChatFill = dynamic(light: "#E6F5F3", dark: "#123832")

    /// Fill behind the Voice action: neutral, so the two tiles read as a
    /// primary action and a secondary one rather than as two peers.
    static let voiceFill = dynamic(light: "#F6F5F4", dark: "#2C2C2E")

    /// Vellum green. Lightened in dark mode, where the light-mode value does
    /// not clear contrast against `surface`.
    static let brand = dynamic(light: "#0E9B8B", dark: "#2FC1AE")

    /// Conversation titles and action labels.
    static let textPrimary = dynamic(light: "#111417", dark: "#F2F2F7")

    /// Group names, the section header, and the empty-state prompt.
    static let textSecondary = dynamic(light: "#7C8894", dark: "#98A2AE")

    /// The dot marking a conversation with something unread in it. Amber
    /// rather than the brand green so it reads as an alert instead of as more
    /// chrome, and so it survives sitting on the green tile's neighbours.
    static let unseenIndicator = dynamic(light: "#FFB200", dark: "#FFC13D")

    /// A color that resolves from the appearance the widget is rendered in.
    ///
    /// Both hex strings go through ``UIColor/init(cssHex:)`` so this file does
    /// not grow a second parser. The fallbacks are unreachable for the
    /// literals above and exist only to keep the result non-optional.
    private static func dynamic(light: String, dark: String) -> Color {
        let lightColor = UIColor(cssHex: light) ?? .white
        let darkColor = UIColor(cssHex: dark) ?? .black
        return Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? darkColor : lightColor
        })
    }
}

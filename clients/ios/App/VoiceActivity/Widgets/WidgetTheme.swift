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

    /// The whole card, for the Quick Actions widget's brand appearance.
    ///
    /// Deepened for dark mode where ``brand`` is lightened, because the two
    /// play opposite roles: `brand` is drawn *on* `surface` and has to separate
    /// from it, while this one *is* the surface, and a mint block would be the
    /// brightest thing on a dark Home Screen.
    static let brandCardSurface = dynamic(light: "#0E9B8B", dark: "#0B7A6E")

    /// Glyphs and text drawn on ``brandCardSurface``. Fixed rather than
    /// dynamic: the card underneath is a deep green in both appearances, so
    /// this answers to the card rather than to the Home Screen behind it.
    static let onBrand = fixed("#FFFFFF")

    /// A control's fill on ``brandCardSurface``: ``onBrand`` at low opacity, so
    /// the action circles and the unread chip read as cut out of the green
    /// rather than as a second color placed on top of it, and the card stays
    /// one block.
    static let onBrandFill = onBrand.opacity(0.22)

    /// The assistant mark's body on the brand card, lighter than the card it
    /// sits on. That contrast is the only reason it is a separate value: a
    /// brand-green mark on a brand-green card is not a mark.
    static let avatarBody = fixed("#7FD7C8")

    /// The mark's eye whites and pupils, carrying the values the product's
    /// avatar compositor draws with so the widget's stand-in is recognizably
    /// the same character. Fixed rather than dynamic for the same reason a
    /// face does not change color with the Home Screen behind it.
    static let avatarSclera = fixed("#F2F2F2")
    static let avatarPupil = fixed("#1A1A1A")

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

    /// A color that is the same in both appearances, for the few values whose
    /// job is to be one specific color rather than to sit legibly on a surface
    /// that changes. Same parser and same unreachable-fallback story as
    /// ``dynamic(light:dark:)``.
    private static func fixed(_ hex: String) -> Color {
        Color(uiColor: UIColor(cssHex: hex) ?? .gray)
    }
}

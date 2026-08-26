import SwiftUI
import UIKit

// A Storybook replica copies this file's measurements and palette, at
// `clients/web/src/components/ios-widget-previews/`. Nothing checks the two
// against each other, so a change here wants a look there.

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
    /// ``surface`` as the hex pair it is built from, so a color washed *into*
    /// the card blends over the same value the card is painted with. See
    /// ``WidgetSoftAccent``.
    fileprivate static let surfaceLightHex = "#FFFFFF"
    fileprivate static let surfaceDarkHex = "#1C1C1E"

    /// The card the whole widget sits on, passed to `containerBackground`.
    static let surface = dynamic(light: surfaceLightHex, dark: surfaceDarkHex)

    /// Fill behind the New Chat action for an account carrying no avatar
    /// accent to wash in: the brand green's own share of the card. See
    /// ``WidgetSoftAccent``, which lands on exactly these values for the
    /// default teal.
    static let newChatFill = dynamic(light: "#E6F5F3", dark: "#123832")

    /// The neutral fill behind a secondary control: the Voice tile beside the
    /// tinted New Chat one, and the camera and voice circles on the light
    /// card. Neutral so the tinted surface beside it reads as the primary
    /// action rather than as one of two peers.
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

    /// The whole card for an account carrying no accent to paint it with: the
    /// surface ``WidgetAvatarPalette`` falls back to.
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
        return appearanceDynamic(light: lightColor, dark: darkColor)
    }

    /// Composes two resolved colors into one that follows the appearance the
    /// widget renders in. The single owner of trait selection for widget
    /// palettes, static literals and render-time derivations alike.
    static func appearanceDynamic(light: UIColor, dark: UIColor) -> Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
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

/// The pale card a New Chat surface sits on, and the color drawn on it.
///
/// The accent arrives as one hex and has to produce a fill for both
/// appearances, so it is washed into ``WidgetTheme/surface`` rather than used
/// neat: a saturated block would swallow the light card it is a control on.
/// This is the light-card counterpart to ``WidgetAvatarPalette``, which paints
/// a whole card with the same accent.
///
/// The foreground is the card's own text color rather than the accent, because
/// a wash this thin barely moves the surface's luminance: an accent legible on
/// its own block can be invisible at a tenth of it, and half the palette would
/// come out unreadable. The accentless fallback draws the mark in the brand
/// green.
struct WidgetSoftAccent {
    /// The accent's share of the light card. Calibrated on the brand green: at
    /// this share `#0E9B8B` over the light surface lands exactly on
    /// ``WidgetTheme/newChatFill``'s light value, so an account whose avatar is
    /// the default teal gets the same tile as an account with no avatar at all.
    private static let lightWash = 0.105

    /// The accent's share of the dark card. Heavier because the wash runs the
    /// other way there, lifting a near-black surface instead of tinting a white
    /// one, and at this share the brand green lands within a shade of
    /// ``WidgetTheme/newChatFill``'s hand-picked dark value.
    private static let darkWash = 0.22

    /// The card behind the mark and the word.
    let fill: Color

    /// The mark and the word drawn on ``fill``.
    let onFill: Color

    /// The wash for an avatar accent, or the static tokens when there is no
    /// accent to work from and when the one on offer is unreadable.
    init(accentHex: String?) {
        guard let accentHex,
              let canonical = canonicalCSSHex(accentHex),
              let light = UIColor(
                  cssHex: blendHex(base: WidgetTheme.surfaceLightHex, overlay: canonical, alpha: Self.lightWash)
              ),
              let dark = UIColor(
                  cssHex: blendHex(base: WidgetTheme.surfaceDarkHex, overlay: canonical, alpha: Self.darkWash)
              )
        else {
            fill = WidgetTheme.newChatFill
            onFill = WidgetTheme.brand
            return
        }
        fill = WidgetTheme.appearanceDynamic(light: light, dark: dark)
        onFill = WidgetTheme.textPrimary
    }
}

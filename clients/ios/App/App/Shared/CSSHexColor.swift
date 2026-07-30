import SwiftUI
import UIKit

/// CSS hex color parsing, shared by the app target and the VoiceActivity
/// widget extension.
///
/// This is the single native parser for the `#RGB` / `#RRGGBB` / `#RRGGBBAA`
/// strings the web side hands across (`--surface-overlay` for the shell
/// background, `accentHex` for the Live Activity). `VoiceSessionAttributes`'s
/// `canonicalAccentHex` validates against exactly this grammar, so a
/// canonicalized accent always parses here.
extension UIColor {
    /// Parse a CSS hex color string (`#RGB`, `#RRGGBB`, or `#RRGGBBAA`) as
    /// reported by `getComputedStyle().getPropertyValue()`. Returns `nil` for
    /// any unrecognised format so the caller can fall back.
    convenience init?(cssHex: String) {
        var s = cssHex.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.hasPrefix("#") else { return nil }
        s.removeFirst()
        if s.count == 3 {
            s = s.map { "\($0)\($0)" }.joined()
        }
        guard s.count == 6 || s.count == 8,
              let value = UInt64(s, radix: 16)
        else { return nil }
        let r, g, b, a: CGFloat
        if s.count == 8 {
            r = CGFloat((value & 0xFF00_0000) >> 24) / 255
            g = CGFloat((value & 0x00FF_0000) >> 16) / 255
            b = CGFloat((value & 0x0000_FF00) >> 8) / 255
            a = CGFloat(value & 0x0000_00FF) / 255
        } else {
            r = CGFloat((value & 0xFF0000) >> 16) / 255
            g = CGFloat((value & 0x00FF00) >> 8) / 255
            b = CGFloat(value & 0x0000FF) / 255
            a = 1
        }
        self.init(red: r, green: g, blue: b, alpha: a)
    }

    /// `.black` or `.white`, whichever has the higher WCAG contrast ratio
    /// against the receiver.
    ///
    /// Used where content sits *on* a web-supplied color, which may be any
    /// brightness — a fixed foreground would be unreadable for half the
    /// palette. Only the receiver's own brightness matters, so the result is
    /// independent of light/dark appearance.
    var contrastingForeground: UIColor {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        guard getRed(&r, green: &g, blue: &b, alpha: &a) else { return .white }
        // WCAG relative luminance; the 0.179 threshold is where contrast
        // against black and against white are equal.
        //
        // `contrastForeground` in `clients/web/src/utils/avatar-tone.ts` is the
        // source of truth for this derivation — the island is meant to match
        // what the voice room renders — so the linearization cutoff is its
        // 0.04045, not the 0.03928 the older WCAG 2.0 text quotes.
        let channels = [r, g, b].map { channel -> CGFloat in
            channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
        }
        let luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
        return luminance > 0.179 ? .black : .white
    }
}

extension Color {
    /// SwiftUI wrapper over ``UIColor/init(cssHex:)`` so SwiftUI surfaces do
    /// not grow a second parser.
    init?(cssHex: String) {
        guard let color = UIColor(cssHex: cssHex) else { return nil }
        self.init(uiColor: color)
    }

    /// See ``UIColor/contrastingForeground``.
    var contrastingForeground: Color {
        Color(uiColor: UIColor(self).contrastingForeground)
    }
}

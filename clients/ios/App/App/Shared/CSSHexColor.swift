import SwiftUI
import UIKit

/// CSS hex color parsing, shared by the app target and the VoiceActivity
/// widget extension.
///
/// This is the single native parser for the `#RGB` / `#RRGGBB` / `#RRGGBBAA`
/// strings the web side hands across (`--surface-overlay` for the shell
/// background, `accentHex` for the Live Activity, the widget snapshot's avatar
/// accent). ``canonicalCSSHex(_:)`` validates against exactly this grammar, so
/// a canonicalized string always parses here.
///
/// It also carries the few derivations a native surface has to make from one
/// of those colors on its own. The web computes them in
/// `clients/web/src/utils/avatar-tone.ts`, which is the source of truth for
/// every one of them; a widget renders in a process that never runs the SPA,
/// so it has to land on the same numbers by doing the same arithmetic.
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

/// Canonicalizes a CSS hex color (`#RGB`, `#RRGGBB`, `#RRGGBBAA`, with the `#`
/// optional) to `#` plus uppercase digits, or `nil` when it is none of those.
///
/// One canonicalizer for every web-supplied color, so the surfaces that read
/// them cannot come to accept different spellings. Each supplies its own answer
/// for `nil`: the Live Activity substitutes its neutral gray, since a running
/// session always renders something, while a widget keeps a nil accent and
/// falls back to its static brand palette.
func canonicalCSSHex(_ raw: String) -> String? {
    var digits = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    if digits.hasPrefix("#") {
        digits.removeFirst()
    }
    if digits.count == 3 {
        digits = digits.map { "\($0)\($0)" }.joined()
    }
    guard digits.count == 6 || digits.count == 8,
          digits.allSatisfy({ $0.isASCII && $0.isHexDigit })
    else {
        return nil
    }
    return "#" + digits
}

/// Multiply every channel of `hex` by `factor`, clamping to the 0-255 range.
///
/// Mirrors `darkenHex` in `clients/web/src/utils/avatar-tone.ts`, the way
/// ``UIColor/contrastingForeground`` mirrors that file's `contrastForeground`.
/// It is how a surface painted with an avatar accent gets its dark-appearance
/// variant: one hex arrives in the snapshot, and both appearances have to come
/// out of it.
///
/// The grammar is deliberately a superset of the web's. `avatar-tone.ts` reads
/// `#RRGGBB` only, while this reads every spelling ``canonicalCSSHex(_:)``
/// accepts and drops the alpha an 8-digit one carries, because what comes out
/// is a card surface and a translucent card is not one. ``WidgetAvatarPalette``
/// squares its light side with that by forcing alpha there too. A string
/// neither side can read comes back unchanged, so the caller's own fallback
/// still has something to reject.
func darkenHex(_ hex: String, _ factor: Double) -> String {
    guard let channels = hexChannels(hex) else {
        return hex
    }
    func scale(_ channel: Int) -> Int {
        return max(0, min(255, Int((Double(channel) * factor).rounded())))
    }
    return hexString(r: scale(channels.r), g: scale(channels.g), b: scale(channels.b))
}

/// Composite `overlay` at `alpha` over the solid `base`, returning the
/// resulting opaque color. Mirrors `blendHex` in `avatar-tone.ts`, including
/// its answer for a color it cannot read: `base`, unchanged.
func blendHex(base: String, overlay: String, alpha: Double) -> String {
    guard let b = hexChannels(base), let o = hexChannels(overlay) else {
        return base
    }
    let a = max(0, min(1, alpha))
    func mix(_ from: Int, _ to: Int) -> Int {
        return Int((Double(from) * (1 - a) + Double(to) * a).rounded())
    }
    return hexString(r: mix(b.r, o.r), g: mix(b.g, o.g), b: mix(b.b, o.b))
}

/// The red, green and blue channels of a CSS hex color as 0-255 integers, or
/// `nil` when the string is not one.
///
/// Grammar comes from ``canonicalCSSHex(_:)`` rather than a second regex, for
/// the reason this file exists at all. Alpha, where the string carries it, is
/// dropped: every derivation above produces a surface, and a surface with a
/// hole in it is not one.
private func hexChannels(_ hex: String) -> (r: Int, g: Int, b: Int)? {
    guard let canonical = canonicalCSSHex(hex),
          let value = UInt64(canonical.dropFirst().prefix(6), radix: 16)
    else {
        return nil
    }
    return (r: Int((value >> 16) & 0xFF), g: Int((value >> 8) & 0xFF), b: Int(value & 0xFF))
}

private func hexString(r: Int, g: Int, b: Int) -> String {
    return String(format: "#%02X%02X%02X", r, g, b)
}

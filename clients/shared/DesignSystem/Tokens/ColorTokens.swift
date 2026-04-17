import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// MARK: - Color Extension

public extension Color {
    init(hex: UInt, alpha: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }

    /// Parse a hex color string (e.g., "#7C3AED" or "7C3AED") into a Color.
    init(hexString: String, alpha: Double = 1.0) {
        let cleaned = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "#", with: "")
        var hexValue: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&hexValue)
        self.init(hex: UInt(hexValue), alpha: alpha)
    }
}

// MARK: - Adaptive Color Helper

/// Creates a `Color` that automatically resolves to `light` or `dark` based on
/// the current system / window appearance.
public func adaptiveColor(light: Color, dark: Color) -> Color {
    #if os(macOS)
    Color(nsColor: NSColor(name: nil, dynamicProvider: { appearance in
        let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        return isDark ? NSColor(dark) : NSColor(light)
    }))
    #else
    Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light)
    })
    #endif
}

// MARK: - Canonical Semantic Tokens

public enum VSemanticColorToken: String, CaseIterable {
    case primaryDisabled
    case primaryBase
    case primaryHover
    case primaryActive
    case primarySecondHover

    case surfaceBase
    case surfaceOverlay
    case surfaceActive
    case surfaceLift
    case surfaceHover

    case borderDisabled
    case borderBase
    case borderHover
    case borderActive
    case borderElement

    case contentEmphasized
    case contentDefault
    case contentSecondary
    case contentTertiary
    case contentDisabled
    case contentBackground
    case contentInset

    case systemPositiveStrong
    case systemPositiveWeak
    case systemNegativeStrong
    case systemNegativeHover
    case systemNegativeWeak
    case systemMidStrong
    case systemMidWeak

    case auxWhite
}

public struct VSemanticColorPair: Equatable {
    public let lightHex: String
    public let darkHex: String

    public init(lightHex: String, darkHex: String) {
        self.lightHex = lightHex
        self.darkHex = darkHex
    }

    public var lightColor: Color { Color(hexString: lightHex) }
    public var darkColor: Color { Color(hexString: darkHex) }
}

private enum FigmaRawColor {
    // Primary
    static let primaryLightDisabled = Color(hex: 0xF6F5F4)
    static let primaryDarkDisabled = Color(hex: 0x2D3339)
    static let primaryLightBase = Color(hex: 0x17191C)
    static let primaryDarkBase = Color(hex: 0xFDFDFC)
    static let primaryLightHover = Color(hex: 0x24292E)
    static let primaryDarkHover = Color(hex: 0xF2F0EE)
    static let primaryLightActive = Color(hex: 0x2D3339)
    static let primaryDarkActive = Color(hex: 0xE9E6E2)
    static let primaryLightSecondHover = Color(hex: 0xB9B4AC)
    static let primaryDarkSecondHover = Color(hex: 0xE9E6E2)

    // Surface
    static let surfaceLightBase = Color(hex: 0xF6F5F4)
    static let surfaceDarkBase = Color(hex: 0x17191C)
    static let surfaceLightOverlay = Color(hex: 0xFDFDFC)
    static let surfaceDarkOverlay = Color(hex: 0x1C2024)
    static let surfaceLightActive = Color(hex: 0xF2F0EE)
    static let surfaceDarkActive = Color(hex: 0x444D56)
    static let surfaceLightLift = Color(hex: 0xFFFFFF)
    static let surfaceDarkLift = Color(hex: 0x24292E)
    static let surfaceLightHover = Color(hex: 0xB9B4AC)
    static let surfaceDarkHover = Color(hex: 0xE9E6E2)

    // Border
    static let borderLightDisabled = Color(hex: 0xE9E6E2)
    static let borderDarkDisabled = Color(hex: 0x1C2024)
    static let borderLightBase = Color(hex: 0xF2F0EE)
    static let borderDarkBase = Color(hex: 0x24292E)
    static let borderLightHover = Color(hex: 0xF6F5F4)
    static let borderDarkHover = Color(hex: 0x2D3339)
    static let borderLightActive = Color(hex: 0x2D3339)
    static let borderDarkActive = Color(hex: 0xF6F5F4)
    static let borderLightElement = Color(hex: 0xCFCCC9)
    static let borderDarkElement = Color(hex: 0x5A6672)

    // Content
    static let contentLightEmphasized = Color(hex: 0x161616)
    static let contentDarkEmphasized = Color(hex: 0xFDFDFC)
    static let contentLightDefault = Color(hex: 0x24292E)
    static let contentDarkDefault = Color(hex: 0xF6F5F4)
    static let contentLightSecondary = Color(hex: 0x5A6672)
    static let contentDarkSecondary = Color(hex: 0xA9B2BB)
    static let contentLightTertiary = Color(hex: 0x71808E)
    static let contentDarkTertiary = Color(hex: 0x8D99A5)
    static let contentLightDisabled = Color(hex: 0xCFCCC9)
    static let contentDarkDisabled = Color(hex: 0x5A6672)
    static let contentLightBackground = Color(hex: 0xF2F0EE)
    static let contentDarkBackground = Color(hex: 0x2D3339)
    static let contentLightInset = Color(hex: 0xFDFDFC)
    static let contentDarkInset = Color(hex: 0x17191C)

    // System
    static let systemLightPositiveStrong = Color(hex: 0x277E41)
    static let systemDarkPositiveStrong = Color(hex: 0x277E41)
    static let systemLightPositiveWeak = Color(hex: 0xE9F2EC)
    static let systemDarkPositiveWeak = Color(hex: 0x1C251F)
    static let systemLightNegativeStrong = Color(hex: 0xDA491A)
    static let systemDarkNegativeStrong = Color(hex: 0xDA491A)
    static let systemLightNegativeHover = Color(hex: 0xE86B40)
    static let systemDarkNegativeHover = Color(hex: 0xAB3F1C)
    static let systemLightNegativeWeak = Color(hex: 0xF7DAC9)
    static let systemDarkNegativeWeak = Color(hex: 0x4E281D)
    static let systemLightMidStrong = Color(hex: 0xF1B21E)
    static let systemDarkMidStrong = Color(hex: 0xF1B21E)
    static let systemLightMidWeak = Color(hex: 0xFCF3DD)
    static let systemDarkMidWeak = Color(hex: 0x4B3D1E)
}

public enum VColor {
    public static let semanticPairs: [VSemanticColorToken: VSemanticColorPair] = [
        .primaryDisabled: .init(lightHex: "#F6F5F4", darkHex: "#2D3339"),
        .primaryBase: .init(lightHex: "#17191C", darkHex: "#FDFDFC"),
        .primaryHover: .init(lightHex: "#24292E", darkHex: "#F2F0EE"),
        .primaryActive: .init(lightHex: "#2D3339", darkHex: "#E9E6E2"),
        .primarySecondHover: .init(lightHex: "#B9B4AC", darkHex: "#E9E6E2"),

        .surfaceBase: .init(lightHex: "#F6F5F4", darkHex: "#17191C"),
        .surfaceOverlay: .init(lightHex: "#FDFDFC", darkHex: "#1C2024"),
        .surfaceActive: .init(lightHex: "#F2F0EE", darkHex: "#444D56"),
        .surfaceLift: .init(lightHex: "#FFFFFF", darkHex: "#24292E"),
        .surfaceHover: .init(lightHex: "#B9B4AC", darkHex: "#E9E6E2"),

        .borderDisabled: .init(lightHex: "#E9E6E2", darkHex: "#1C2024"),
        .borderBase: .init(lightHex: "#F2F0EE", darkHex: "#24292E"),
        .borderHover: .init(lightHex: "#F6F5F4", darkHex: "#2D3339"),
        .borderActive: .init(lightHex: "#2D3339", darkHex: "#F6F5F4"),
        .borderElement: .init(lightHex: "#CFCCC9", darkHex: "#5A6672"),

        .contentEmphasized: .init(lightHex: "#161616", darkHex: "#FDFDFC"),
        .contentDefault: .init(lightHex: "#24292E", darkHex: "#F6F5F4"),
        .contentSecondary: .init(lightHex: "#5A6672", darkHex: "#A9B2BB"),
        .contentTertiary: .init(lightHex: "#71808E", darkHex: "#8D99A5"),
        .contentDisabled: .init(lightHex: "#CFCCC9", darkHex: "#5A6672"),
        .contentBackground: .init(lightHex: "#F2F0EE", darkHex: "#2D3339"),
        .contentInset: .init(lightHex: "#FDFDFC", darkHex: "#17191C"),

        .systemPositiveStrong: .init(lightHex: "#277E41", darkHex: "#277E41"),
        .systemPositiveWeak: .init(lightHex: "#E9F2EC", darkHex: "#1C251F"),
        .systemNegativeStrong: .init(lightHex: "#DA491A", darkHex: "#DA491A"),
        .systemNegativeHover: .init(lightHex: "#E86B40", darkHex: "#AB3F1C"),
        .systemNegativeWeak: .init(lightHex: "#F7DAC9", darkHex: "#4E281D"),
        .systemMidStrong: .init(lightHex: "#F1B21E", darkHex: "#F1B21E"),
        .systemMidWeak: .init(lightHex: "#FCF3DD", darkHex: "#4B3D1E"),

        .auxWhite: .init(lightHex: "#FFFFFF", darkHex: "#FFFFFF"),
    ]

    // Primary
    public static let primaryDisabled = adaptiveColor(light: FigmaRawColor.primaryLightDisabled, dark: FigmaRawColor.primaryDarkDisabled)
    public static let primaryBase = adaptiveColor(light: FigmaRawColor.primaryLightBase, dark: FigmaRawColor.primaryDarkBase)
    public static let primaryHover = adaptiveColor(light: FigmaRawColor.primaryLightHover, dark: FigmaRawColor.primaryDarkHover)
    public static let primaryActive = adaptiveColor(light: FigmaRawColor.primaryLightActive, dark: FigmaRawColor.primaryDarkActive)
    public static let primarySecondHover = adaptiveColor(light: FigmaRawColor.primaryLightSecondHover, dark: FigmaRawColor.primaryDarkSecondHover)

    // Surface
    public static let surfaceBase = adaptiveColor(light: FigmaRawColor.surfaceLightBase, dark: FigmaRawColor.surfaceDarkBase)
    public static let surfaceOverlay = adaptiveColor(light: FigmaRawColor.surfaceLightOverlay, dark: FigmaRawColor.surfaceDarkOverlay)
    public static let surfaceActive = adaptiveColor(light: FigmaRawColor.surfaceLightActive, dark: FigmaRawColor.surfaceDarkActive)
    public static let surfaceLift = adaptiveColor(light: FigmaRawColor.surfaceLightLift, dark: FigmaRawColor.surfaceDarkLift)
    public static let surfaceHover = adaptiveColor(light: FigmaRawColor.surfaceLightHover, dark: FigmaRawColor.surfaceDarkHover)

    // Border
    public static let borderDisabled = adaptiveColor(light: FigmaRawColor.borderLightDisabled, dark: FigmaRawColor.borderDarkDisabled)
    public static let borderBase = adaptiveColor(light: FigmaRawColor.borderLightBase, dark: FigmaRawColor.borderDarkBase)
    public static let borderHover = adaptiveColor(light: FigmaRawColor.borderLightHover, dark: FigmaRawColor.borderDarkHover)
    public static let borderActive = adaptiveColor(light: FigmaRawColor.borderLightActive, dark: FigmaRawColor.borderDarkActive)
    public static let borderElement = adaptiveColor(light: FigmaRawColor.borderLightElement, dark: FigmaRawColor.borderDarkElement)

    // Content
    public static let contentEmphasized = adaptiveColor(light: FigmaRawColor.contentLightEmphasized, dark: FigmaRawColor.contentDarkEmphasized)
    public static let contentDefault = adaptiveColor(light: FigmaRawColor.contentLightDefault, dark: FigmaRawColor.contentDarkDefault)
    public static let contentSecondary = adaptiveColor(light: FigmaRawColor.contentLightSecondary, dark: FigmaRawColor.contentDarkSecondary)
    public static let contentTertiary = adaptiveColor(light: FigmaRawColor.contentLightTertiary, dark: FigmaRawColor.contentDarkTertiary)
    public static let contentDisabled = adaptiveColor(light: FigmaRawColor.contentLightDisabled, dark: FigmaRawColor.contentDarkDisabled)
    public static let contentBackground = adaptiveColor(light: FigmaRawColor.contentLightBackground, dark: FigmaRawColor.contentDarkBackground)
    public static let contentInset = adaptiveColor(light: FigmaRawColor.contentLightInset, dark: FigmaRawColor.contentDarkInset)

    // System
    public static let systemPositiveStrong = adaptiveColor(light: FigmaRawColor.systemLightPositiveStrong, dark: FigmaRawColor.systemDarkPositiveStrong)
    public static let systemPositiveWeak = adaptiveColor(light: FigmaRawColor.systemLightPositiveWeak, dark: FigmaRawColor.systemDarkPositiveWeak)
    public static let systemNegativeStrong = adaptiveColor(light: FigmaRawColor.systemLightNegativeStrong, dark: FigmaRawColor.systemDarkNegativeStrong)
    public static let systemNegativeHover = adaptiveColor(light: FigmaRawColor.systemLightNegativeHover, dark: FigmaRawColor.systemDarkNegativeHover)
    public static let systemNegativeWeak = adaptiveColor(light: FigmaRawColor.systemLightNegativeWeak, dark: FigmaRawColor.systemDarkNegativeWeak)
    public static let systemMidStrong = adaptiveColor(light: FigmaRawColor.systemLightMidStrong, dark: FigmaRawColor.systemDarkMidStrong)
    public static let systemMidWeak = adaptiveColor(light: FigmaRawColor.systemLightMidWeak, dark: FigmaRawColor.systemDarkMidWeak)

    // Pending / queued — warm amber for "held, waiting" affordances (queue drawer accent bar,
    // pending badge backgrounds). Opacity is baked in so the token sits softly over surface
    // colors without an additional modifier.
    public static let systemPendingSoft = adaptiveColor(
        light: Color(.sRGB, red: 0.85, green: 0.58, blue: 0.18, opacity: 0.6),
        dark: Color(.sRGB, red: 0.98, green: 0.72, blue: 0.35, opacity: 0.55)
    )

    // Diff view — adaptive background tints for unified-diff line highlighting.
    public static let diffAddedBg  = adaptiveColor(light: Color(hex: 0xEDF2EB), dark: Color(hex: 0x073D2E))
    public static let diffRemovedBg = adaptiveColor(light: Color(hex: 0xFFF3EE), dark: Color(hex: 0x4E281D))
    public static let diffHunkBg   = adaptiveColor(light: Color(hex: 0xDDE4EE), dark: Color(hex: 0x1E2A38))

    // Syntax highlighting — adaptive tokens shared by SyntaxTheme and HighlightedTextView.
    // Light values are high-contrast for light surfaces; dark values are softer pastels.
    public static let syntaxString = adaptiveColor(
        light: Color(.sRGB, red: 0.72, green: 0.19, blue: 0.10),
        dark: Color(.sRGB, red: 0.87, green: 0.55, blue: 0.47)
    )
    public static let syntaxNumber = adaptiveColor(
        light: Color(.sRGB, red: 0.55, green: 0.28, blue: 0.73),
        dark: Color(.sRGB, red: 0.73, green: 0.56, blue: 0.87)
    )
    public static let syntaxKeyword = adaptiveColor(
        light: Color(.sRGB, red: 0.33, green: 0.25, blue: 0.80),
        dark: Color(.sRGB, red: 0.55, green: 0.65, blue: 0.96)
    )
    public static let syntaxComment = adaptiveColor(
        light: Color(.sRGB, red: 0.42, green: 0.47, blue: 0.42),
        dark: Color(.sRGB, red: 0.55, green: 0.60, blue: 0.55)
    )
    public static let syntaxType = adaptiveColor(
        light: Color(.sRGB, red: 0.15, green: 0.55, blue: 0.52),
        dark: Color(.sRGB, red: 0.45, green: 0.78, blue: 0.74)
    )
    public static let syntaxProperty = adaptiveColor(
        light: Color(.sRGB, red: 0.35, green: 0.50, blue: 0.68),
        dark: Color(.sRGB, red: 0.68, green: 0.78, blue: 0.88)
    )
    public static let syntaxLink = adaptiveColor(
        light: Color(.sRGB, red: 0.12, green: 0.52, blue: 0.32),
        dark: Color(.sRGB, red: 0.30, green: 0.75, blue: 0.55)
    )

    // Glass surfaces — translucent fills, faint borders, and dual-shadow tones for
    // floating cards and pills. Applied via the `.glassCard()` modifier
    // (see GlassCardModifier). Opacity is baked into each token so the modifier
    // code stays declarative.
    public static let glassFill = adaptiveColor(
        light: Color(hex: 0xFFFFFF, alpha: 0.72),
        dark: Color(hex: 0x1E2024, alpha: 0.72)
    )
    public static let glassStroke = adaptiveColor(
        light: Color(hex: 0x000000, alpha: 0.06),
        dark: Color(hex: 0xFFFFFF, alpha: 0.06)
    )
    public static let glassShadowNear = adaptiveColor(
        light: Color(hex: 0x000000, alpha: 0.08),
        dark: Color(hex: 0x000000, alpha: 0.30)
    )
    public static let glassShadowFar = adaptiveColor(
        light: Color(hex: 0x000000, alpha: 0.06),
        dark: Color(hex: 0x000000, alpha: 0.25)
    )

    // Utility: non-adaptive explicit white/black for overlays, shadows, text-on-filled
    public static let auxWhite = Color(hex: 0xFFFFFF)
    public static let auxBlack = Color(hex: 0x000000)

    // Secondary "fun" colors — non-adaptive, used for decorative elements like the skills graph
    public static let funYellow = Color(hex: 0xE9C91A)
    public static let funRed    = Color(hex: 0xEF4400)
    public static let funPurple = Color(hex: 0xA665C9)
    public static let funPink   = Color(hex: 0xDB4B77)
    public static let funCoral  = Color(hex: 0xE9642F)
    public static let funTeal   = Color(hex: 0x0E9B8B)
    public static let funGreen  = Color(hex: 0x4C9B50)
    public static let funBlue   = Color(hex: 0x3B82F6)

    // Role tag backgrounds — adaptive pastel backgrounds for contact role badges
    public static let tagAssistant = adaptiveColor(light: Color(hex: 0xF0D9E0), dark: Color(hex: 0x3D2A35))
    public static let tagGuardian  = adaptiveColor(light: Color(hex: 0xC8E5E2), dark: Color(hex: 0x2A4A45))
    public static let tagHuman     = adaptiveColor(light: Color(hex: 0xEFE8C4), dark: Color(hex: 0x4A4530))

    public static func pair(for token: VSemanticColorToken) -> VSemanticColorPair {
        guard let pair = semanticPairs[token] else {
            preconditionFailure("Missing semantic color pair for token: \(token.rawValue)")
        }
        return pair
    }
}

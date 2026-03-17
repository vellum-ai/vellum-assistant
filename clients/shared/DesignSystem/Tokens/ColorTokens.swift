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

// MARK: - Raw Palette Scales (Token Internals Only)

enum Emerald {
    static let _950 = Color(hex: 0x073D2E)
    static let _900 = Color(hex: 0x0A5843)
    static let _800 = Color(hex: 0x0C7356)
    static let _700 = Color(hex: 0x10906A)
    static let _600 = Color(hex: 0x18B07A)
    static let _500 = Color(hex: 0x38CF93)
    static let _400 = Color(hex: 0x6EE7B5)
    static let _300 = Color(hex: 0xA6F2D1)
    static let _200 = Color(hex: 0xD2F9E8)
    static let _100 = Color(hex: 0xECFDF5)
}

public enum Danger {
    public static let _950 = Color(hex: 0x4E281D)
    public static let _900 = Color(hex: 0x803017)
    public static let _800 = Color(hex: 0xAB3F1C)
    public static let _700 = Color(hex: 0xDA491A)
    public static let _600 = Color(hex: 0xE86B40)
    public static let _500 = Color(hex: 0xF39B74)
    public static let _400 = Color(hex: 0xF9C0A2)
    public static let _300 = Color(hex: 0xF7DAC9)
    public static let _200 = Color(hex: 0xFFE4D5)
    public static let _100 = Color(hex: 0xFFF3EE)
}

public enum Amber {
    public static let _950 = Color(hex: 0x5E3207)
    public static let _900 = Color(hex: 0x7A4409)
    public static let _800 = Color(hex: 0xA35E0C)
    public static let _700 = Color(hex: 0xC97C10)
    public static let _600 = Color(hex: 0xE8A020)
    public static let _550 = Color(hex: 0xF1B21E)
    public static let _500 = Color(hex: 0xFAC426)
    public static let _400 = Color(hex: 0xFDD94E)
    public static let _300 = Color(hex: 0xFEEC94)
    public static let _200 = Color(hex: 0xFEF7CD)
    public static let _100 = Color(hex: 0xFEFCE8)
}

enum Stone {
    static let _950 = Color(hex: 0x1C1917)
    static let _900 = Color(hex: 0x292524)
    static let _800 = Color(hex: 0x44403C)
    static let _700 = Color(hex: 0x57534E)
    static let _600 = Color(hex: 0x78716C)
    static let _500 = Color(hex: 0x97918B)
    static let _400 = Color(hex: 0xA8A29E)
    static let _300 = Color(hex: 0xD6D3D1)
    static let _200 = Color(hex: 0xE7E5E4)
    static let _100 = Color(hex: 0xF5F5F4)
    static let _50  = Color(hex: 0xFAFAF9)
}

enum Slate {
    static let _950 = Stone._950
    static let _900 = Stone._900
    static let _800 = Stone._800
    static let _700 = Stone._700
    static let _600 = Stone._600
    static let _500 = Stone._500
    static let _400 = Stone._400
    static let _300 = Stone._300
    static let _200 = Stone._200
    static let _100 = Stone._100
    static let _50  = Stone._50
}

enum Moss {
    static let _950 = Color(hex: 0x20201E)
    static let _900 = Color(hex: 0x2A2A28)
    static let _700 = Color(hex: 0x3A3A37)
    static let _600 = Color(hex: 0x4A4A46)
    static let _500 = Color(hex: 0x6B6B65)
    static let _400 = Color(hex: 0xA1A096)
    static let _300 = Color(hex: 0xBDB9A9)
    static let _200 = Color(hex: 0xD4D1C1)
    static let _100 = Color(hex: 0xE8E6DA)
    static let _50  = Color(hex: 0xF5F3EB)
}

public enum Forest {
    public static let _950 = Color(hex: 0x1A2316)
    public static let _900 = Color(hex: 0x2A3825)
    public static let _800 = Color(hex: 0x3D4F36)
    public static let _700 = Color(hex: 0x516748)
    public static let _600 = Color(hex: 0x657D5B)
    public static let _500 = Color(hex: 0x7A8B6F)
    public static let _400 = Color(hex: 0x98A88F)
    public static let _300 = Color(hex: 0xB5C3AE)
    public static let _200 = Color(hex: 0xD4DFD0)
    public static let _100 = Color(hex: 0xEDF2EB)
}

enum Sage {
    static let _950 = Forest._950
    static let _900 = Forest._900
    static let _800 = Forest._800
    static let _700 = Forest._700
    static let _600 = Forest._600
    static let _500 = Forest._500
    static let _400 = Forest._400
    static let _300 = Forest._300
    static let _200 = Forest._200
    static let _100 = Forest._100
}

// MARK: - Canonical Semantic Tokens

public enum VSemanticColorToken: String, CaseIterable {
    case primaryDisabled
    case primaryBase
    case primaryHover
    case primaryActive

    case surfaceBase
    case surfaceOverlay
    case surfaceActive
    case surfaceLift

    case borderDisabled
    case borderBase
    case borderHover
    case borderActive

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
    static let primaryLightDisabled = Color(hex: 0xD4D1C1)
    static let primaryDarkDisabled = Color(hex: 0x3A3A37)
    static let primaryLightBase = Color(hex: 0x516748)
    static let primaryDarkBase = Color(hex: 0x657D5B)
    static let primaryLightHover = Color(hex: 0x657D5B)
    static let primaryDarkHover = Color(hex: 0x516748)
    static let primaryLightActive = Color(hex: 0x7A8B6F)
    static let primaryDarkActive = Color(hex: 0x7A8B6F)

    // Surface
    static let surfaceLightBase = Color(hex: 0xE8E6DA)
    static let surfaceDarkBase = Color(hex: 0x2A2A28)
    static let surfaceLightOverlay = Color(hex: 0xF5F3EB)
    static let surfaceDarkOverlay = Color(hex: 0x20201E)
    static let surfaceLightActive = Color(hex: 0xD4D1C1)
    static let surfaceDarkActive = Color(hex: 0x3A3A37)
    static let surfaceLightLift = Color(hex: 0xFFFFFF)
    static let surfaceDarkLift = Color(hex: 0x000000)

    // Border
    static let borderLightDisabled = Color(hex: 0xD4D1C1)
    static let borderDarkDisabled = Color(hex: 0x3A3A37)
    static let borderLightBase = Color(hex: 0xBDB9A9)
    static let borderDarkBase = Color(hex: 0x4A4A46)
    static let borderLightHover = Color(hex: 0xA1A096)
    static let borderDarkHover = Color(hex: 0x6B6B65)
    static let borderLightActive = Color(hex: 0x7A8B6F)
    static let borderDarkActive = Color(hex: 0x7A8B6F)

    // Content
    static let contentLightEmphasized = Color(hex: 0x20201E)
    static let contentDarkEmphasized = Color(hex: 0xF5F3EB)
    static let contentLightDefault = Color(hex: 0x2A2A28)
    static let contentDarkDefault = Color(hex: 0xE8E6DA)
    static let contentLightSecondary = Color(hex: 0x4A4A46)
    static let contentDarkSecondary = Color(hex: 0xBDB9A9)
    static let contentLightTertiary = Color(hex: 0xA1A096)
    static let contentDarkTertiary = Color(hex: 0xA1A096)
    static let contentLightDisabled = Color(hex: 0xBDB9A9)
    static let contentDarkDisabled = Color(hex: 0x6B6B65)
    static let contentLightBackground = Color(hex: 0xD4D1C1)
    static let contentDarkBackground = Color(hex: 0x3A3A37)
    static let contentLightInset = Color(hex: 0xFFFFFF)
    static let contentDarkInset = Color(hex: 0x000000)

    // System
    static let systemLightPositiveStrong = Color(hex: 0x516748)
    static let systemDarkPositiveStrong = Color(hex: 0x516748)
    static let systemLightPositiveWeak = Color(hex: 0xD4DFD0)
    static let systemDarkPositiveWeak = Color(hex: 0x1A2316)
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
        .primaryDisabled: .init(lightHex: "#D4D1C1", darkHex: "#3A3A37"),
        .primaryBase: .init(lightHex: "#516748", darkHex: "#657D5B"),
        .primaryHover: .init(lightHex: "#657D5B", darkHex: "#516748"),
        .primaryActive: .init(lightHex: "#7A8B6F", darkHex: "#7A8B6F"),

        .surfaceBase: .init(lightHex: "#E8E6DA", darkHex: "#2A2A28"),
        .surfaceOverlay: .init(lightHex: "#F5F3EB", darkHex: "#20201E"),
        .surfaceActive: .init(lightHex: "#D4D1C1", darkHex: "#3A3A37"),
        .surfaceLift: .init(lightHex: "#FFFFFF", darkHex: "#000000"),

        .borderDisabled: .init(lightHex: "#D4D1C1", darkHex: "#3A3A37"),
        .borderBase: .init(lightHex: "#BDB9A9", darkHex: "#4A4A46"),
        .borderHover: .init(lightHex: "#A1A096", darkHex: "#6B6B65"),
        .borderActive: .init(lightHex: "#7A8B6F", darkHex: "#7A8B6F"),

        .contentEmphasized: .init(lightHex: "#20201E", darkHex: "#F5F3EB"),
        .contentDefault: .init(lightHex: "#2A2A28", darkHex: "#E8E6DA"),
        .contentSecondary: .init(lightHex: "#4A4A46", darkHex: "#BDB9A9"),
        .contentTertiary: .init(lightHex: "#A1A096", darkHex: "#A1A096"),
        .contentDisabled: .init(lightHex: "#BDB9A9", darkHex: "#6B6B65"),
        .contentBackground: .init(lightHex: "#D4D1C1", darkHex: "#3A3A37"),
        .contentInset: .init(lightHex: "#FFFFFF", darkHex: "#000000"),

        .systemPositiveStrong: .init(lightHex: "#516748", darkHex: "#516748"),
        .systemPositiveWeak: .init(lightHex: "#D4DFD0", darkHex: "#1A2316"),
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

    // Surface
    public static let surfaceBase = adaptiveColor(light: FigmaRawColor.surfaceLightBase, dark: FigmaRawColor.surfaceDarkBase)
    public static let surfaceOverlay = adaptiveColor(light: FigmaRawColor.surfaceLightOverlay, dark: FigmaRawColor.surfaceDarkOverlay)
    public static let surfaceActive = adaptiveColor(light: FigmaRawColor.surfaceLightActive, dark: FigmaRawColor.surfaceDarkActive)
    public static let surfaceLift = adaptiveColor(light: FigmaRawColor.surfaceLightLift, dark: FigmaRawColor.surfaceDarkLift)

    // Border
    public static let borderDisabled = adaptiveColor(light: FigmaRawColor.borderLightDisabled, dark: FigmaRawColor.borderDarkDisabled)
    public static let borderBase = adaptiveColor(light: FigmaRawColor.borderLightBase, dark: FigmaRawColor.borderDarkBase)
    public static let borderHover = adaptiveColor(light: FigmaRawColor.borderLightHover, dark: FigmaRawColor.borderDarkHover)
    public static let borderActive = adaptiveColor(light: FigmaRawColor.borderLightActive, dark: FigmaRawColor.borderDarkActive)

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

    // Syntax highlighting — adaptive tokens shared by SyntaxTheme and JSONTreeView.
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

    // Role tag backgrounds — adaptive pastel backgrounds for contact role badges
    public static let tagAssistant = adaptiveColor(light: Color(hex: 0xF0D9E0), dark: Color(hex: 0x3D2A35))
    public static let tagGuardian  = adaptiveColor(light: Color(hex: 0xC8E5E2), dark: Color(hex: 0x2A4A45))
    public static let tagHuman     = adaptiveColor(light: Color(hex: 0xEFE8C4), dark: Color(hex: 0x4A4530))

    /// Deterministic conversation icon background palette — semantic compositions of existing tokens.
    public static let conversationIconBackgrounds: [Color] = [
        primaryBase, primaryHover, primaryActive,
        systemPositiveStrong, systemNegativeStrong, systemMidStrong,
        contentSecondary, contentTertiary,
    ]

    public static func pair(for token: VSemanticColorToken) -> VSemanticColorPair {
        guard let pair = semanticPairs[token] else {
            preconditionFailure("Missing semantic color pair for token: \(token.rawValue)")
        }
        return pair
    }
}

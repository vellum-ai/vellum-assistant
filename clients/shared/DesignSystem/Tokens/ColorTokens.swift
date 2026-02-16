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

// MARK: - Color Scales

public enum Slate {
    public static let _950 = Color(hex: 0x070D19)
    public static let _900 = Color(hex: 0x0F172A)
    public static let _800 = Color(hex: 0x1E293B)
    public static let _700 = Color(hex: 0x334155)
    public static let _600 = Color(hex: 0x475569)
    public static let _500 = Color(hex: 0x64748B)
    public static let _400 = Color(hex: 0x94A3B8)
    public static let _300 = Color(hex: 0xCBD5E1)
    public static let _200 = Color(hex: 0xE2E8F0)
    public static let _100 = Color(hex: 0xF1F5F9)
    public static let _50  = Color(hex: 0xF8FAFC)
}

public enum Emerald {
    public static let _950 = Color(hex: 0x073D2E)
    public static let _900 = Color(hex: 0x0A5843)
    public static let _800 = Color(hex: 0x0C7356)
    public static let _700 = Color(hex: 0x10906A)
    public static let _600 = Color(hex: 0x18B07A)
    public static let _500 = Color(hex: 0x38CF93)
    public static let _400 = Color(hex: 0x6EE7B5)
    public static let _300 = Color(hex: 0xA6F2D1)
    public static let _200 = Color(hex: 0xD2F9E8)
    public static let _100 = Color(hex: 0xECFDF5)
}

public enum Violet {
    public static let _950 = Color(hex: 0x321669)
    public static let _900 = Color(hex: 0x4A2390)
    public static let _800 = Color(hex: 0x5C2FB2)
    public static let _700 = Color(hex: 0x7240CC)
    public static let _600 = Color(hex: 0x8A5BE0)
    public static let _500 = Color(hex: 0x9878EA)
    public static let _400 = Color(hex: 0xB8A6F1)
    public static let _300 = Color(hex: 0xD4C8F7)
    public static let _200 = Color(hex: 0xE8E1FB)
    public static let _100 = Color(hex: 0xF4F0FD)
}

public enum Indigo {
    public static let _950 = Color(hex: 0x180F66)
    public static let _900 = Color(hex: 0x261A96)
    public static let _800 = Color(hex: 0x3525C4)
    public static let _700 = Color(hex: 0x4636E8)
    public static let _600 = Color(hex: 0x5B4EFF)
    public static let _500 = Color(hex: 0x7B6BFF)
    public static let _400 = Color(hex: 0x9488FF)
    public static let _300 = Color(hex: 0xB8B4FF)
    public static let _200 = Color(hex: 0xD8D8FF)
    public static let _100 = Color(hex: 0xEEEEFF)
}

public enum Rose {
    public static let _950 = Color(hex: 0x620F21)
    public static let _900 = Color(hex: 0x85142F)
    public static let _800 = Color(hex: 0xA8183E)
    public static let _700 = Color(hex: 0xD02050)
    public static let _600 = Color(hex: 0xE84060)
    public static let _500 = Color(hex: 0xF06A86)
    public static let _400 = Color(hex: 0xF99AAE)
    public static let _300 = Color(hex: 0xFCBFC9)
    public static let _200 = Color(hex: 0xFFE1E6)
    public static let _100 = Color(hex: 0xFFF1F3)
}

public enum Amber {
    public static let _950 = Color(hex: 0x5E3207)
    public static let _900 = Color(hex: 0x7A4409)
    public static let _800 = Color(hex: 0xA35E0C)
    public static let _700 = Color(hex: 0xC97C10)
    public static let _600 = Color(hex: 0xE8A020)
    public static let _500 = Color(hex: 0xFAC426)
    public static let _400 = Color(hex: 0xFDD94E)
    public static let _300 = Color(hex: 0xFEEC94)
    public static let _200 = Color(hex: 0xFEF7CD)
    public static let _100 = Color(hex: 0xFEFCE8)
}

// MARK: - Semantic Color Tokens

public enum VColor {
    // Backgrounds
    public static let background = adaptiveColor(light: .white, dark: Slate._950)
    public static let backgroundSubtle = adaptiveColor(light: Slate._100, dark: Slate._800)
    public static let chatBackground = adaptiveColor(light: Slate._50, dark: Slate._900)
    public static let surface = adaptiveColor(light: .white, dark: Slate._800)
    public static let surfaceBorder = adaptiveColor(light: Slate._200, dark: Slate._700)
    public static let surfaceSubtle = adaptiveColor(light: Slate._50, dark: Slate._900)

    // Text
    public static let textPrimary = adaptiveColor(light: Slate._900, dark: Slate._50)
    public static let textSecondary = adaptiveColor(light: Slate._600, dark: Slate._400)
    public static let textMuted = adaptiveColor(light: Slate._500, dark: Slate._500)

    // Accent (violet = primary)
    public static let accent = adaptiveColor(light: Violet._700, dark: Violet._600)
    public static let accentSubtle = Violet._100

    // Onboarding accent (amber) — always dark theme
    public static let onboardingAccent = Amber._500
    public static let onboardingAccentDark = Amber._600
    public static let onboardingAccentDarker = Amber._800

    // Status
    public static let success = adaptiveColor(light: Emerald._700, dark: Emerald._600)
    public static let error = adaptiveColor(light: Rose._700, dark: Rose._600)
    public static let warning = adaptiveColor(light: Amber._700, dark: Amber._600)

    // Interactive states
    public static let ghostHover = adaptiveColor(light: Slate._100, dark: Slate._700)
    public static let ghostPressed = adaptiveColor(light: Slate._200, dark: Slate._600)
    public static let divider = adaptiveColor(light: Slate._200, dark: Slate._700)
    public static let hoverOverlay = adaptiveColor(light: Color(hex: 0x000000), dark: .white)
    public static let toggleOff = adaptiveColor(light: Slate._300, dark: Slate._700)
    public static let toggleBorder = adaptiveColor(light: Slate._400, dark: Slate._600)
}

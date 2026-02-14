import SwiftUI

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
    public static let background = Slate._950
    public static let backgroundSubtle = Slate._800
    public static let chatBackground = Slate._900
    public static let surface = Slate._800
    public static let surfaceBorder = Slate._700

    // Text
    public static let textPrimary = Slate._50
    public static let textSecondary = Slate._400
    public static let textMuted = Slate._500

    // Accent (violet = primary)
    public static let accent = Violet._600
    public static let accentSubtle = Violet._100

    // Onboarding accent (amber)
    public static let onboardingAccent = Amber._500
    public static let onboardingAccentDark = Amber._600
    public static let onboardingAccentDarker = Amber._800

    // Status
    public static let success = Emerald._600
    public static let error = Rose._600
    public static let warning = Amber._600
}

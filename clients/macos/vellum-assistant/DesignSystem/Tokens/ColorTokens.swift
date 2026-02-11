import SwiftUI

// MARK: - Color Extension

extension Color {
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

enum Slate {
    static let _900 = Color(hex: 0x0F172A)
    static let _800 = Color(hex: 0x1E293B)
    static let _700 = Color(hex: 0x334155)
    static let _600 = Color(hex: 0x475569)
    static let _500 = Color(hex: 0x64748B)
    static let _400 = Color(hex: 0x94A3B8)
    static let _300 = Color(hex: 0xCBD5E1)
    static let _200 = Color(hex: 0xE2E8F0)
    static let _100 = Color(hex: 0xF1F5F9)
    static let _50  = Color(hex: 0xF8FAFC)
}

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

enum Violet {
    static let _950 = Color(hex: 0x321669)
    static let _900 = Color(hex: 0x4A2390)
    static let _800 = Color(hex: 0x5C2FB2)
    static let _700 = Color(hex: 0x7240CC)
    static let _600 = Color(hex: 0x8A5BE0)
    static let _500 = Color(hex: 0x9878EA)
    static let _400 = Color(hex: 0xB8A6F1)
    static let _300 = Color(hex: 0xD4C8F7)
    static let _200 = Color(hex: 0xE8E1FB)
    static let _100 = Color(hex: 0xF4F0FD)
}

enum Indigo {
    static let _950 = Color(hex: 0x180F66)
    static let _900 = Color(hex: 0x261A96)
    static let _800 = Color(hex: 0x3525C4)
    static let _700 = Color(hex: 0x4636E8)
    static let _600 = Color(hex: 0x5B4EFF)
    static let _500 = Color(hex: 0x7B6BFF)
    static let _400 = Color(hex: 0x9488FF)
    static let _300 = Color(hex: 0xB8B4FF)
    static let _200 = Color(hex: 0xD8D8FF)
    static let _100 = Color(hex: 0xEEEEFF)
}

enum Rose {
    static let _950 = Color(hex: 0x620F21)
    static let _900 = Color(hex: 0x85142F)
    static let _800 = Color(hex: 0xA8183E)
    static let _700 = Color(hex: 0xD02050)
    static let _600 = Color(hex: 0xE84060)
    static let _500 = Color(hex: 0xF06A86)
    static let _400 = Color(hex: 0xF99AAE)
    static let _300 = Color(hex: 0xFCBFC9)
    static let _200 = Color(hex: 0xFFE1E6)
    static let _100 = Color(hex: 0xFFF1F3)
}

enum Amber {
    static let _950 = Color(hex: 0x5E3207)
    static let _900 = Color(hex: 0x7A4409)
    static let _800 = Color(hex: 0xA35E0C)
    static let _700 = Color(hex: 0xC97C10)
    static let _600 = Color(hex: 0xE8A020)
    static let _500 = Color(hex: 0xFAC426)
    static let _400 = Color(hex: 0xFDD94E)
    static let _300 = Color(hex: 0xFEEC94)
    static let _200 = Color(hex: 0xFEF7CD)
    static let _100 = Color(hex: 0xFEFCE8)
}

// MARK: - Semantic Color Tokens

enum VColor {
    // Backgrounds
    static let background = Slate._900
    static let backgroundSubtle = Slate._800
    static let surface = Slate._800
    static let surfaceBorder = Slate._700

    // Text
    static let textPrimary = Slate._50
    static let textSecondary = Slate._400
    static let textMuted = Slate._500

    // Accent (violet = primary)
    static let accent = Violet._600
    static let accentSubtle = Violet._100

    // Onboarding accent (amber)
    static let onboardingAccent = Amber._500
    static let onboardingAccentDark = Amber._600
    static let onboardingAccentDarker = Amber._800

    // Status
    static let success = Emerald._600
    static let error = Rose._600
    static let warning = Amber._600
}

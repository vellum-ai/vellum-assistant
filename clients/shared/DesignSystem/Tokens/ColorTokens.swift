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

public enum Danger {
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

/// Warm neutral scale for light mode — sandstone/limestone tones.
public enum Stone {
    public static let _950 = Color(hex: 0x1C1917)
    public static let _900 = Color(hex: 0x292524)
    public static let _800 = Color(hex: 0x44403C)
    public static let _700 = Color(hex: 0x57534E)
    public static let _600 = Color(hex: 0x78716C)
    public static let _500 = Color(hex: 0x97918B)
    public static let _400 = Color(hex: 0xA8A29E)
    public static let _300 = Color(hex: 0xD6D3D1)
    public static let _200 = Color(hex: 0xE7E5E4)
    public static let _100 = Color(hex: 0xF5F5F4)
    public static let _50  = Color(hex: 0xFAFAF9)
}

// MARK: - Dark Theme Scales

/// Warm neutral scale for dark mode backgrounds & text.
public enum Moss {
    public static let _950 = Color(hex: 0x262624)
    public static let _900 = Color(hex: 0x2A2A28)
    public static let _800 = Color(hex: 0x2F2F2D)
    public static let _700 = Color(hex: 0x3A3A37)
    public static let _600 = Color(hex: 0x4A4A46)
    public static let _500 = Color(hex: 0x6B6B65)
    public static let _400 = Color(hex: 0xA1A096)
    public static let _300 = Color(hex: 0xBDB9A9)
    public static let _200 = Color(hex: 0xD4D1C1)
    public static let _100 = Color(hex: 0xE8E6DA)
    public static let _50  = Color(hex: 0xF5F3EB)
}

/// Forest green accent scale for dark mode.
public enum Forest {
    public static let _950 = Color(hex: 0x0A2A14)
    public static let _900 = Color(hex: 0x123D1F)
    public static let _800 = Color(hex: 0x18522A)
    public static let _700 = Color(hex: 0x1C5F30)
    public static let _600 = Color(hex: 0x216C37)
    public static let _500 = Color(hex: 0x3A8A4F)
    public static let _400 = Color(hex: 0x5AAB6A)
    public static let _300 = Color(hex: 0x85C991)
    public static let _200 = Color(hex: 0xB5E1BC)
    public static let _100 = Color(hex: 0xE2F4E5)
}

// MARK: - Semantic Color Tokens

public enum VColor {
    // Backgrounds
    public static let background = adaptiveColor(light: .white, dark: Moss._950)
    public static let backgroundSubtle = adaptiveColor(light: Stone._100, dark: Moss._950)
    public static let chatBackground = adaptiveColor(light: .white, dark: Moss._950)
    public static let surface = adaptiveColor(light: .white, dark: Moss._800)
    public static let surfaceBorder = adaptiveColor(light: Stone._200, dark: Moss._700)
    public static let surfaceSubtle = adaptiveColor(light: Stone._50, dark: Moss._900)

    // Text
    public static let textPrimary = adaptiveColor(light: Stone._900, dark: Moss._50)
    public static let textSecondary = adaptiveColor(light: Stone._600, dark: Moss._400)
    public static let textMuted = adaptiveColor(light: Stone._500, dark: Moss._500)

    // Accent
    public static let accent = adaptiveColor(light: Color(hex: 0x262624), dark: Forest._600)

    // Send button — always green
    public static let sendButton = Color(hex: 0x216C37)
    public static let accentSubtle = adaptiveColor(light: Forest._100, dark: Forest._900)

    // Onboarding accent (amber) — always dark theme
    public static let onboardingAccent = Amber._500
    public static let onboardingAccentDark = Amber._600
    public static let onboardingAccentDarker = Amber._800

    // Status
    public static let success = adaptiveColor(light: Emerald._700, dark: Emerald._600)
    public static let error = adaptiveColor(light: Danger._700, dark: Danger._600)
    public static let warning = adaptiveColor(light: Amber._700, dark: Amber._600)

    // Chat
    public static let userBubble = adaptiveColor(light: Stone._200, dark: Color(hex: 0x191919))
    public static let userBubbleText = adaptiveColor(light: Stone._900, dark: Moss._200)
    public static let userBubbleTextSecondary = adaptiveColor(light: Stone._600, dark: Moss._200.opacity(0.8))

    // Interactive states
    public static let ghostHover = adaptiveColor(light: Stone._100, dark: Moss._700)
    public static let ghostPressed = adaptiveColor(light: Stone._200, dark: Moss._600)
    public static let divider = adaptiveColor(light: Stone._200, dark: Moss._700)
    public static let hoverOverlay = adaptiveColor(light: Color(hex: 0x000000), dark: Moss._200)
    public static let toggleOff = adaptiveColor(light: Stone._300, dark: Moss._700)
    public static let toggleBorder = adaptiveColor(light: Stone._400, dark: Moss._600)

    // Slash command highlight — green tint for /command tokens in composer and chat
    public static let slashCommand = adaptiveColor(light: Forest._500, dark: Forest._300)
}

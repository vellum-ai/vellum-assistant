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

/// Cool neutral scale — alias of Stone for contexts expecting Tailwind-style "slate".
public enum Slate {
    public static let _950 = Stone._950
    public static let _900 = Stone._900
    public static let _800 = Stone._800
    public static let _700 = Stone._700
    public static let _600 = Stone._600
    public static let _500 = Stone._500
    public static let _400 = Stone._400
    public static let _300 = Stone._300
    public static let _200 = Stone._200
    public static let _100 = Stone._100
    public static let _50  = Stone._50
}

/// Sage green accent scale — alias of Forest for onboarding UI.
public enum Sage {
    public static let _950 = Forest._950
    public static let _900 = Forest._900
    public static let _800 = Forest._800
    public static let _700 = Forest._700
    public static let _600 = Forest._600
    public static let _500 = Forest._500
    public static let _400 = Forest._400
    public static let _300 = Forest._300
    public static let _200 = Forest._200
    public static let _100 = Forest._100
}

// MARK: - Dark Theme Scales

/// Warm neutral scale for dark mode backgrounds & text.
public enum Moss {
    public static let _950 = Color(hex: 0x20201E)
    public static let _900 = Color(hex: 0x2A2A28)
    public static let _700 = Color(hex: 0x3A3A37)
    public static let _600 = Color(hex: 0x4A4A46)
    public static let _500 = Color(hex: 0x6B6B65)
    public static let _400 = Color(hex: 0xA1A096)
    public static let _300 = Color(hex: 0xBDB9A9)
    public static let _200 = Color(hex: 0xD4D1C1)
    public static let _100 = Color(hex: 0xE8E6DA)
    public static let _50  = Color(hex: 0xF5F3EB)
}

/// Sage green accent scale for dark mode.
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

// MARK: - Semantic Color Tokens

public enum VColor {
    // Backgrounds
    public static let background = adaptiveColor(light: Moss._100, dark: Moss._900)
    public static let backgroundSubtle = adaptiveColor(light: Moss._50, dark: Moss._950)
    public static let chatBackground = adaptiveColor(light: Moss._100, dark: Moss._900)
    public static let surface = adaptiveColor(light: .white, dark: Moss._700)
    public static let surfaceBorder = adaptiveColor(light: Moss._100, dark: Moss._600)
    public static let cardBorder = adaptiveColor(light: Color(hex: 0xE8E6DA), dark: Color(hex: 0x4A4A46))
    public static let surfaceSubtle = adaptiveColor(light: Moss._50, dark: Moss._900)
    public static let inputBackground = adaptiveColor(light: Moss._100, dark: Moss._700)

    // Text
    public static let textPrimary = adaptiveColor(light: Stone._900, dark: Moss._50)
    public static let textSecondary = adaptiveColor(light: Stone._700, dark: Moss._400)
    public static let textMuted = adaptiveColor(light: Stone._600, dark: Moss._500)

    // Accent
    public static let accent = adaptiveColor(light: Color(hex: 0x262624), dark: Forest._600)

    // Icon & button accent
    public static let iconAccent = adaptiveColor(light: Color(hex: 0x537D53), dark: Forest._500)

    // Active/highlighted icon foreground — lighter green in dark mode for better contrast
    public static let activeIconForeground = adaptiveColor(light: Color(hex: 0x537D53), dark: Forest._300)

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
    public static let codeBackground = adaptiveColor(light: Moss._200, dark: Moss._700)
    public static let codeText = adaptiveColor(light: Color(hex: 0xDC2626), dark: Color(hex: 0xF87171))
    public static let userBubble = adaptiveColor(light: Moss._200, dark: Moss._950)
    public static let userBubbleText = adaptiveColor(light: Stone._900, dark: Moss._50)
    public static let userBubbleTextSecondary = adaptiveColor(light: Stone._600, dark: Moss._50.opacity(0.8))

    // Navigation
    public static let navHover = adaptiveColor(light: Color(hex: 0xE8E6DA), dark: Moss._700)
    public static let navActive = adaptiveColor(light: Color(hex: 0xD4DFD0), dark: Moss._600)
    public static let segmentSelected = adaptiveColor(light: .white, dark: Moss._600)
    public static let segmentHover = adaptiveColor(light: Stone._100, dark: Moss._600)

    // Interactive states
    public static let ghostHover = adaptiveColor(light: Stone._100, dark: Moss._700)
    public static let ghostPressed = adaptiveColor(light: Stone._200, dark: Moss._600)
    public static let divider = adaptiveColor(light: Stone._300, dark: Moss._600)
    public static let hoverOverlay = adaptiveColor(light: Color(hex: 0x000000), dark: Moss._200)
    public static let toggleOn = adaptiveColor(light: Color(hex: 0x2A3825), dark: Forest._600)
    public static let toggleOff = adaptiveColor(light: Color(hex: 0xE8E6DA), dark: Moss._700)
    public static let toggleBorder = adaptiveColor(light: Stone._400, dark: Moss._600)
    public static let toggleKnob = adaptiveColor(light: Stone._50, dark: Color.white)
    public static let toggleKnobDisabled = adaptiveColor(light: Color(hex: 0xBDB9A9), dark: Moss._500)

    // Slash command highlight — green tint for /command tokens in composer and chat
    public static let slashCommand = adaptiveColor(light: Forest._500, dark: Forest._300)

    // Button colors
    public static let buttonPrimary = adaptiveColor(light: Color(hex: 0x537D53), dark: Color(hex: 0x537D53))
    public static let buttonPrimaryHover = adaptiveColor(light: Color(hex: 0x629062), dark: Color(hex: 0x629062))
    public static let buttonPrimaryPressed = adaptiveColor(light: Color(hex: 0x456C47), dark: Color(hex: 0x456C47))
    public static let buttonSecondaryBg = adaptiveColor(light: Color(hex: 0xD4DFD4), dark: Moss._700)
    public static let buttonSecondaryBgHover = adaptiveColor(light: Color(hex: 0xCBD8CB), dark: Color(hex: 0x424240))
    public static let buttonSecondaryBgPressed = adaptiveColor(light: Color(hex: 0xC3D2C3), dark: Moss._600)
    public static let buttonSecondaryBorder = adaptiveColor(light: Color(hex: 0x537D53), dark: Forest._500)
    public static let buttonSecondaryText = adaptiveColor(light: Color(hex: 0x537D53), dark: Forest._400)
    public static let buttonTertiaryBackground = adaptiveColor(light: Moss._200, dark: Moss._700)

    // Neutral button — dark fill that works in both light and dark modes
    public static let buttonNeutral = adaptiveColor(light: Stone._800, dark: Moss._500)
    public static let buttonNeutralHover = adaptiveColor(light: Stone._700, dark: Moss._400)
    public static let buttonNeutralPressed = adaptiveColor(light: Stone._900, dark: Moss._600)

    // Danger button
    public static let buttonDanger = Color(hex: 0xC1421B)
    public static let buttonDangerHover = Color(hex: 0xD4582F)
    public static let buttonDangerPressed = Color(hex: 0xE0745A)

    // Tag & shortcut
    public static let tagText = adaptiveColor(light: Moss._500, dark: Moss._400)
    public static let tagBorder = adaptiveColor(light: Stone._300, dark: Moss._100)

    // Unread indicator
    public static let unreadIndicator = Danger._600

    // Skill type pill colors
    public static let skillCoreForeground = adaptiveColor(light: Color(hex: 0x2A2A28), dark: Moss._200)
    public static let skillCoreBackground = adaptiveColor(light: Moss._100, dark: Moss._700)
    public static let skillInstalledForeground = adaptiveColor(light: Color(hex: 0x3A6B3A), dark: Forest._400)
    public static let skillInstalledBackground = adaptiveColor(light: Color(hex: 0xD4E8D4), dark: Forest._900)
    public static let skillCreatedForeground = adaptiveColor(light: Color(hex: 0x3A4A6B), dark: Color(hex: 0x8AAED4))
    public static let skillCreatedBackground = adaptiveColor(light: Color(hex: 0xD4DCE8), dark: Color(hex: 0x2A3A4E))
    public static let skillExtraForeground = adaptiveColor(light: Color(hex: 0x6B6B5E), dark: Moss._400)
    public static let skillExtraBackground = adaptiveColor(light: Color(hex: 0xDDDBCE), dark: Moss._700)

    // Skill category colors (constellation)
    public static let skillCatCommunication = Color(hex: 0x8B5DAA)
    public static let skillCatProductivity = Color(hex: 0x4682B4)
    public static let skillCatDevelopment = Color(hex: 0xC1421B)
    public static let skillCatMedia = Color(hex: 0xD4A017)
    public static let skillCatAutomation = Color(hex: 0x2E8B57)
    public static let skillCatWebSocial = Color(hex: 0xCD853F)
    public static let skillCatKnowledge = Color(hex: 0x6B8E23)
    public static let skillCatIntegration = Color(hex: 0x708090)

    // Thread icon backgrounds
    public static let threadIconBackgrounds: [Color] = [
        Color(hex: 0x4B6845), // forest green
        Color(hex: 0x4A5568), // slate blue-gray
        Color(hex: 0x5B4E3A), // warm brown
        Color(hex: 0x3D5A5B), // teal
        Color(hex: 0x6B4C5A), // muted mauve
        Color(hex: 0x4E5D3E), // olive
        Color(hex: 0x5A4A6B), // dusty purple
        Color(hex: 0x5C6B4A), // sage
    ]

    // Theme toggle
    public static let themeToggleSelected = adaptiveColor(light: Color(hex: 0xD3DECF), dark: Forest._800)
    public static let themeToggleBackground = adaptiveColor(light: Moss._100, dark: Moss._700)

    // Onboarding
    public static let onboardingGradientEdge = adaptiveColor(light: Stone._100, dark: Moss._900)
    public static let onboardingGradientOuter = adaptiveColor(light: Stone._200, dark: Moss._950)
    public static let onboardingHatchGradientOuter = adaptiveColor(light: Moss._200, dark: Moss._950)
    public static let onboardingStepBackground = adaptiveColor(light: Stone._900, dark: Forest._600)
    public static let onboardingFileIcon = adaptiveColor(light: Stone._900, dark: Forest._600)
    public static let onboardingLink = adaptiveColor(light: Color(hex: 0x262624), dark: Forest._400)
    public static let onboardingBorderStroke = adaptiveColor(light: Stone._900.opacity(0.3), dark: Forest._600.opacity(0.3))

    // Onboarding code block
    public static let codeBlockBackground = adaptiveColor(light: Color(hex: 0xF2F2F7), dark: Color(hex: 0x3A3A37).opacity(0.5))

    // Slider
    public static let sliderTrack = adaptiveColor(light: Moss._100, dark: Moss._700)
    public static let sliderFill = adaptiveColor(light: Forest._300, dark: Forest._500)

    // App card (inline chat widget)
    public static let appCardBackground = adaptiveColor(light: Color(hex: 0xF5F3EB), dark: Color(hex: 0x20201E))

    // Subagent / skill chip
    public static let statusRunning = adaptiveColor(light: Forest._600, dark: Forest._400)
    public static let skillChipBorder = adaptiveColor(light: Amber._400, dark: Amber._600)

    // Contextual text — primary in light, secondary in dark
    public static let contextualText = adaptiveColor(light: Stone._900, dark: Moss._400)

    // Panel divider — used in identity panel sidebar
    public static let panelDivider = adaptiveColor(light: Moss._50, dark: Moss._500)

    // Composer background fill
    public static let composerBackground = adaptiveColor(light: Moss._200, dark: Moss._700)

    // Voice composer — inverse/high-contrast tokens for voice mode
    public static let voiceComposerBackground = adaptiveColor(light: Slate._900, dark: Color(hex: 0xE8E6DA))
    public static let voiceComposerTextPrimary = adaptiveColor(light: .white, dark: Slate._900)
    public static let voiceComposerTextSecondary = adaptiveColor(light: Slate._300, dark: Slate._400)
    public static let voiceComposerControlBackground = adaptiveColor(light: Slate._800, dark: Slate._800)

    // Microphone icon color
    public static let micIcon = adaptiveColor(light: Forest._500, dark: Moss._400)

    // Success button states
    public static let buttonSuccessBg = adaptiveColor(light: Forest._200, dark: Forest._900)
    public static let buttonSuccessBgHover = adaptiveColor(light: Forest._300, dark: Forest._800)
    public static let buttonSuccessBgPressed = adaptiveColor(light: Forest._400, dark: Forest._700)

    // Icon button ghost states
    public static let iconGhostActiveBg = adaptiveColor(light: Moss._100, dark: Moss._700)
    public static let iconGhostActivePressed = adaptiveColor(light: Moss._200, dark: Moss._600)
    public static let iconGhostActiveDisabled = adaptiveColor(light: Moss._100, dark: Moss._700)

    // Sidebar drop indicator
    public static let dropIndicator = adaptiveColor(light: Forest._500, dark: Forest._400)

    // Sidebar action text (Show more / Show less)
    public static let sidebarActionText = adaptiveColor(light: Forest._600, dark: Forest._400)
}

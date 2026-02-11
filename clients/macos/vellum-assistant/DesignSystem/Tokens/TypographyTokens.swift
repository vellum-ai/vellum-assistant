import SwiftUI

enum VFont {
    // Onboarding — Silkscreen (pixel font)
    static let onboardingTitle = Font.custom("Silkscreen-Regular", size: 28)
    static let onboardingSubtitle = Font.custom("Silkscreen-Regular", size: 15)

    // App — system fonts
    static let heading = Font.system(.headline)
    static let body = Font.system(size: 15)
    static let bodyMedium = Font.system(size: 15, weight: .medium)
    static let caption = Font.system(size: 13)
    static let captionMedium = Font.system(size: 13, weight: .medium)
    static let small = Font.system(size: 12)
    static let cardTitle = Font.system(size: 17, weight: .semibold)
    static let cardEmoji = Font.system(size: 32)
    static let mono = Font.system(size: 16, weight: .medium, design: .monospaced)
}

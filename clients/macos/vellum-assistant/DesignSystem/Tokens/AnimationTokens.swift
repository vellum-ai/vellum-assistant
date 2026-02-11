import SwiftUI

/// Animation presets. Use instead of raw Animation values.
enum VAnimation {
    static let fast     = Animation.easeOut(duration: 0.15)
    static let standard = Animation.easeInOut(duration: 0.25)
    static let slow     = Animation.easeInOut(duration: 0.4)
    static let spring   = Animation.spring(response: 0.3, dampingFraction: 0.8)

    /// Gentle spring for panel open/close
    static let panel    = Animation.spring(response: 0.35, dampingFraction: 0.85)

    /// Bouncy spring for celebratory/attention-grabbing motion
    static let bouncy   = Animation.spring(response: 0.3, dampingFraction: 0.5)

    // MARK: - Durations (for use with withAnimation or explicit timing)

    static let durationFast: TimeInterval     = 0.15
    static let durationStandard: TimeInterval = 0.25
    static let durationSlow: TimeInterval     = 0.4
}

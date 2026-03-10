import SwiftUI

/// Animation presets. Use instead of raw Animation values.
public enum VAnimation {
    public static let snappy   = Animation.easeOut(duration: 0.12)
    public static let fast     = Animation.easeOut(duration: 0.15)
    public static let standard = Animation.easeInOut(duration: 0.25)
    public static let slow     = Animation.easeInOut(duration: 0.4)
    public static let spring   = Animation.spring(response: 0.3, dampingFraction: 0.8)

    /// Gentle spring for panel open/close
    public static let panel    = Animation.spring(response: 0.35, dampingFraction: 0.85)

    /// Bouncy spring for celebratory/attention-grabbing motion
    public static let bouncy   = Animation.spring(response: 0.3, dampingFraction: 0.5)

    // MARK: - Durations (for use with withAnimation or explicit timing)

    public static let durationFast: TimeInterval     = 0.15
    public static let durationStandard: TimeInterval = 0.25
    public static let durationSlow: TimeInterval     = 0.4
}

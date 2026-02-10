import Foundation

/// Centralised timing constants matching the React version.
enum HatchTiming {
    static let wobbleCrack1: TimeInterval = 1.5
    static let wobbleCrack2: TimeInterval = 2.5
    static let wobbleCrack3: TimeInterval = 3.5
    static let wobbleToCrack: TimeInterval = 4.0
    static let crackToBurst: TimeInterval = 2.0
    static let burstToReveal: TimeInterval = 1.5
    static let revealToast: TimeInterval = 0.8
}

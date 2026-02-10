import Foundation

/// Centralised timing constants for the hatch animation (~5s total).
enum HatchTiming {
    static let wobbleCrack1: TimeInterval = 0.9
    static let wobbleCrack2: TimeInterval = 1.5
    static let wobbleCrack3: TimeInterval = 2.1
    static let wobbleToCrack: TimeInterval = 2.4
    static let crackToBurst: TimeInterval = 1.2
    static let burstToReveal: TimeInterval = 0.9
    static let revealToast: TimeInterval = 0.5
}

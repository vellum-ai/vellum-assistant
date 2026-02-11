import Foundation

/// The state machine stages for the hatch animation.
enum HatchStage: String, CaseIterable {
    case idle
    case wobble
    case crack
    case burst
    case reveal
}

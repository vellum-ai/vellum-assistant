import Foundation

/// Placeholder for the deterministic evolution engine.
/// The evolving-monster concept was removed — this is a no-op stub.
enum DeterministicEvolutionEngine {
    enum Milestone {
        case hatched
        case named
        case permissionsGranted
        case firstTask
    }

    @MainActor
    static func applyMilestone(_ milestone: Milestone, to state: AvatarEvolutionState) {
        // No-op — evolution concept removed
    }
}

import Foundation

/// Tracks progressive avatar evolution state during onboarding.
/// Placeholder — the full evolving-monster concept was removed (see commit 565fa9bd4),
/// but OnboardingState still references this type.
@Observable
@MainActor
final class AvatarEvolutionState {
    private static let persistKey = "avatarEvolution.state"

    func load() {
        // No-op — evolution concept removed
    }

    func save() {
        // No-op — evolution concept removed
    }

    static func clearPersistedState() {
        UserDefaults.standard.removeObject(forKey: persistKey)
    }
}

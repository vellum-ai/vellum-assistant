import Foundation
import SwiftUI

/// Tracks the avatar's evolution lifecycle, trait scores, feature unlocks, and user overrides.
@Observable @MainActor
final class AvatarEvolutionState {
    // MARK: - Lifecycle

    enum LifecycleStage: String, Codable {
        case setupPending       // Before hatch
        case blobHatched        // Minimal blob visible
        case identityEvolving   // During onboarding conversation
        case stabilized         // Post-onboarding, identity complete
    }

    var stage: LifecycleStage = .setupPending

    // MARK: - Trait Scores (0.0–1.0 bounded)

    struct TraitScores: Codable, Equatable {
        var warmth: Double = 0.5      // cold/analytical ↔ warm/empathetic
        var energy: Double = 0.5      // calm/steady ↔ energetic/chaotic
        var formality: Double = 0.5   // casual/playful ↔ formal/professional
        var playfulness: Double = 0.5 // serious/focused ↔ whimsical/fun

        /// Clamp all values to 0.0–1.0
        mutating func clamp() {
            warmth = min(max(warmth, 0.0), 1.0)
            energy = min(max(energy, 0.0), 1.0)
            formality = min(max(formality, 0.0), 1.0)
            playfulness = min(max(playfulness, 0.0), 1.0)
        }
    }

    var traits: TraitScores = TraitScores()

    // MARK: - Feature Unlocks

    enum VisualFeature: String, Codable, CaseIterable {
        case blob           // Base shape, minimal
        case eyes           // Eyes appear
        case coreFace       // Expression style (mouth, brows)
        case baseBody       // Body color direction
        case accessories    // Outfit items enabled
        case fullExpression // Full trait-driven appearance
    }

    var unlockedFeatures: Set<VisualFeature> = []

    // MARK: - Appearance Fields

    enum AppearanceField: String, Codable, CaseIterable {
        case bodyColor
        case cheekColor
        case hat
        case hatColor
        case shirt
        case shirtColor
        case accessory
        case accessoryColor
        case heldItem
    }

    // MARK: - User Overrides

    /// User-set values for specific appearance fields
    var userOverrides: [AppearanceField: String] = [:]

    /// Fields locked by the user (won't be auto-evolved)
    var lockedFields: Set<AppearanceField> = []

    // MARK: - Checkpoint Metadata

    var lastCheckpointTurn: Int = 0
    var lastCheckpointDate: Date?

    // MARK: - Applied Milestones

    var appliedMilestones: Set<String> = []

    // MARK: - Persistence

    private static let persistenceID = "avatarEvolutionState"

    func save() {
        let data = PersistableState(
            stage: stage,
            traits: traits,
            unlockedFeatures: Array(unlockedFeatures),
            userOverrides: userOverrides.reduce(into: [:]) { $0[$1.key.rawValue] = $1.value },
            lockedFields: Array(lockedFields.map(\.rawValue)),
            lastCheckpointTurn: lastCheckpointTurn,
            appliedMilestones: Array(appliedMilestones)
        )
        if let encoded = try? JSONEncoder().encode(data) {
            UserDefaults.standard.set(encoded, forKey: Self.persistenceID)
        }
    }

    func load() {
        guard let data = UserDefaults.standard.data(forKey: Self.persistenceID),
              let state = try? JSONDecoder().decode(PersistableState.self, from: data) else { return }

        stage = state.stage
        traits = state.traits
        unlockedFeatures = Set(state.unlockedFeatures)
        userOverrides = state.userOverrides.reduce(into: [:]) {
            if let field = AppearanceField(rawValue: $1.key) {
                $0[field] = $1.value
            }
        }
        lockedFields = Set(state.lockedFields.compactMap { AppearanceField(rawValue: $0) })
        lastCheckpointTurn = state.lastCheckpointTurn
        appliedMilestones = Set(state.appliedMilestones)
    }

    static func clearPersistedState() {
        UserDefaults.standard.removeObject(forKey: persistenceID)
    }

    private struct PersistableState: Codable {
        let stage: LifecycleStage
        let traits: TraitScores
        let unlockedFeatures: [VisualFeature]
        let userOverrides: [String: String]
        let lockedFields: [String]
        let lastCheckpointTurn: Int
        let appliedMilestones: [String]
    }
}

import Foundation

/// Maps onboarding milestones to guaranteed visual unlocks.
/// These transitions are deterministic and don't depend on model output.
enum OnboardingMilestone: String, CaseIterable {
    case hatched              // Egg cracked, blob visible
    case nameChosen           // User/assistant agreed on a name
    case personalityDefined   // Personality established
    case emojiChosen          // Emoji selected
    case soulDiscussed        // SOUL.md conversation happened (or skipped)
    case homeBaseCreated      // Home Base created, onboarding complete
}

/// Context passed with a milestone to provide additional information
/// for deterministic trait hints.
struct MilestoneContext {
    var personalityText: String?
    var emoji: String?

    init(personalityText: String? = nil, emoji: String? = nil) {
        self.personalityText = personalityText
        self.emoji = emoji
    }
}

@MainActor
enum DeterministicEvolutionEngine {

    /// Apply a milestone to the evolution state.
    /// Returns true if the milestone caused a state change.
    @discardableResult
    static func applyMilestone(
        _ milestone: OnboardingMilestone,
        to state: AvatarEvolutionState,
        context: MilestoneContext = MilestoneContext()
    ) -> Bool {
        guard !state.appliedMilestones.contains(milestone.rawValue) else { return false }

        state.appliedMilestones.insert(milestone.rawValue)

        switch milestone {
        case .hatched:
            state.stage = .blobHatched
            state.unlockedFeatures.insert(.blob)

        case .nameChosen:
            state.stage = .identityEvolving
            state.unlockedFeatures.insert(.eyes)

        case .personalityDefined:
            state.unlockedFeatures.insert(.coreFace)
            if let personality = context.personalityText {
                applyPersonalityHints(personality, to: state)
            }

        case .emojiChosen:
            state.unlockedFeatures.insert(.baseBody)
            if let emoji = context.emoji {
                applyEmojiColorHint(emoji, to: state)
            }

        case .soulDiscussed:
            state.unlockedFeatures.insert(.accessories)

        case .homeBaseCreated:
            state.stage = .stabilized
            state.unlockedFeatures.insert(.fullExpression)
        }

        state.save()
        return true
    }

    // MARK: - Deterministic Trait Hints

    /// Apply personality keyword hints to trait scores.
    /// These are gentle nudges, not hard overrides. Model inference refines later.
    private static func applyPersonalityHints(_ text: String, to state: AvatarEvolutionState) {
        let lower = text.lowercased()

        // Warmth signals
        if matchesAny(["warm", "friendly", "kind", "empathetic"], in: lower) {
            state.traits.warmth = min(state.traits.warmth + 0.2, 1.0)
        }
        if matchesAny(["cold", "analytical", "blunt", "direct"], in: lower) {
            state.traits.warmth = max(state.traits.warmth - 0.2, 0.0)
        }

        // Energy signals
        if matchesAny(["energetic", "chaotic", "hyper", "excitable"], in: lower) {
            state.traits.energy = min(state.traits.energy + 0.2, 1.0)
        }
        if matchesAny(["calm", "steady", "chill", "relaxed"], in: lower) {
            state.traits.energy = max(state.traits.energy - 0.2, 0.0)
        }

        // Formality signals
        if matchesAny(["formal", "professional", "serious", "proper"], in: lower) {
            state.traits.formality = min(state.traits.formality + 0.2, 1.0)
        }
        if matchesAny(["casual", "laid back", "informal"], in: lower) {
            state.traits.formality = max(state.traits.formality - 0.2, 0.0)
        }

        // Playfulness signals
        if matchesAny(["playful", "fun", "silly", "goofy", "snarky"], in: lower) {
            state.traits.playfulness = min(state.traits.playfulness + 0.2, 1.0)
        }
        if matchesAny(["focused", "no-nonsense", "stern"], in: lower) {
            state.traits.playfulness = max(state.traits.playfulness - 0.2, 0.0)
        }

        state.traits.clamp()
    }

    // MARK: - Word Matching

    /// Match a signal word using word boundaries to avoid substring collisions
    /// (e.g., "formal" in "informal", "fun" in "function").
    private static func matchesWholeWord(_ word: String, in text: String) -> Bool {
        let pattern = "\\b\(NSRegularExpression.escapedPattern(for: word))\\b"
        return text.range(of: pattern, options: .regularExpression) != nil
    }

    /// Returns true if any of the given words match as whole words in the text.
    private static func matchesAny(_ words: [String], in text: String) -> Bool {
        words.contains { matchesWholeWord($0, in: text) }
    }

    /// Derive a color hint from the chosen emoji.
    /// Maps common emoji color families to body color suggestions.
    private static func applyEmojiColorHint(_ emoji: String, to state: AvatarEvolutionState) {
        let colorMap: [(emojis: [String], color: String)] = [
            (["🔴", "❤️", "🍎", "🌹", "🔥", "💃"], "red"),
            (["🟠", "🧡", "🍊", "🦊", "🎃"], "orange"),
            (["🟡", "💛", "⭐", "🌟", "🌻", "✨"], "amber"),
            (["🟢", "💚", "🌿", "🍀", "🐸", "🌲"], "emerald"),
            (["🔵", "💙", "🌊", "🦋", "💎"], "blue"),
            (["🟣", "💜", "🔮", "🍇", "👾"], "violet"),
            (["🩷", "💗", "💖", "🌸", "🦩"], "pink"),
            (["🩵", "🧊", "❄️", "🐬"], "cyan"),
            (["🪨", "🌫️", "🦈", "⚡"], "slate"),
            (["💐", "🌺", "🥀", "💝", "🫀"], "rose"),
            (["🧬", "🪐", "🌌", "🎵", "🦑"], "indigo"),
            (["🌱", "🥝", "🐢", "🧩"], "green"),
        ]

        for (emojis, color) in colorMap {
            if emojis.contains(where: { emoji.contains($0) }) {
                if !state.lockedFields.contains(.bodyColor) {
                    state.userOverrides[.bodyColor] = color
                    state.lockedFields.insert(.bodyColor)
                }
                return
            }
        }
    }
}

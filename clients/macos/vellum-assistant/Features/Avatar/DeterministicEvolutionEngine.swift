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
    var assistantName: String?

    init(personalityText: String? = nil, emoji: String? = nil, assistantName: String? = nil) {
        self.personalityText = personalityText
        self.emoji = emoji
        self.assistantName = assistantName
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
        if lower.contains("warm") || lower.contains("friendly") || lower.contains("kind") || lower.contains("empathetic") {
            state.traits.warmth = min(state.traits.warmth + 0.2, 1.0)
        }
        if lower.contains("cold") || lower.contains("analytical") || lower.contains("blunt") || lower.contains("direct") {
            state.traits.warmth = max(state.traits.warmth - 0.2, 0.0)
        }

        // Energy signals
        if lower.contains("energetic") || lower.contains("chaotic") || lower.contains("hyper") || lower.contains("excitable") {
            state.traits.energy = min(state.traits.energy + 0.2, 1.0)
        }
        if lower.contains("calm") || lower.contains("steady") || lower.contains("chill") || lower.contains("relaxed") {
            state.traits.energy = max(state.traits.energy - 0.2, 0.0)
        }

        // Formality signals
        if lower.contains("formal") || lower.contains("professional") || lower.contains("serious") || lower.contains("proper") {
            state.traits.formality = min(state.traits.formality + 0.2, 1.0)
        }
        if lower.contains("casual") || lower.contains("laid back") || lower.contains("informal") {
            state.traits.formality = max(state.traits.formality - 0.2, 0.0)
        }

        // Playfulness signals
        if lower.contains("playful") || lower.contains("fun") || lower.contains("silly") || lower.contains("goofy") || lower.contains("snarky") {
            state.traits.playfulness = min(state.traits.playfulness + 0.2, 1.0)
        }
        if lower.contains("focused") || lower.contains("no-nonsense") || lower.contains("stern") {
            state.traits.playfulness = max(state.traits.playfulness - 0.2, 0.0)
        }

        state.traits.clamp()
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
                }
                return
            }
        }
    }
}

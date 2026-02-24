import Foundation

/// Merges deterministic baseline, model-driven traits, and user overrides
/// into a resolved LooksConfig for avatar appearance.
/// Precedence: user overrides > deterministic constraints > model-driven traits > defaults
@MainActor
public enum AvatarEvolutionResolver {

    /// Resolve the current evolution state into a LooksConfig.
    public static func resolve(state: AvatarEvolutionState) -> LooksConfig {
        // Start with defaults
        var bodyColor = "violet"
        var cheekColor = "rose"
        var hat = "none"
        var hatColor: String?
        var shirt = "none"
        var shirtColor: String?
        var accessory = "none"
        var accessoryColor: String?
        var heldItem = "none"

        // Layer 1: Model-driven traits (only if enough features unlocked)
        // Skip fields the user has locked — those should not be auto-evolved.
        if state.unlockedFeatures.contains(.baseBody) {
            if !state.lockedFields.contains(.bodyColor) {
                bodyColor = colorFromWarmth(state.traits.warmth)
            }
            if !state.lockedFields.contains(.cheekColor) {
                cheekColor = cheekColorFromWarmth(state.traits.warmth)
            }
        }

        if state.unlockedFeatures.contains(.accessories) {
            if !state.lockedFields.contains(.hat) {
                hat = hatFromTraits(state.traits)
            }
            if !state.lockedFields.contains(.shirt) {
                shirt = shirtFromTraits(state.traits)
            }
            if !state.lockedFields.contains(.accessory) {
                accessory = accessoryFromTraits(state.traits)
            }
            if !state.lockedFields.contains(.heldItem) {
                heldItem = heldItemFromTraits(state.traits)
            }
        }

        // Layer 2: User overrides (always win for unlocked fields)
        applyOverride(state: state, field: .bodyColor, value: &bodyColor)
        applyOverride(state: state, field: .cheekColor, value: &cheekColor)
        applyOverride(state: state, field: .hat, value: &hat)
        applyOptionalOverride(state: state, field: .hatColor, value: &hatColor)
        applyOverride(state: state, field: .shirt, value: &shirt)
        applyOptionalOverride(state: state, field: .shirtColor, value: &shirtColor)
        applyOverride(state: state, field: .accessory, value: &accessory)
        applyOptionalOverride(state: state, field: .accessoryColor, value: &accessoryColor)
        applyOverride(state: state, field: .heldItem, value: &heldItem)

        return LooksConfig(
            bodyColor: bodyColor,
            cheekColor: cheekColor,
            hat: hat,
            hatColor: hatColor,
            shirt: shirt,
            shirtColor: shirtColor,
            accessory: accessory,
            accessoryColor: accessoryColor,
            heldItem: heldItem
        )
    }

    // MARK: - Override Helpers

    private static func applyOverride(
        state: AvatarEvolutionState,
        field: AvatarEvolutionState.AppearanceField,
        value: inout String
    ) {
        if let override = state.userOverrides[field] {
            value = override
        }
    }

    private static func applyOptionalOverride(
        state: AvatarEvolutionState,
        field: AvatarEvolutionState.AppearanceField,
        value: inout String?
    ) {
        if let override = state.userOverrides[field] {
            value = override == "none" ? nil : override
        }
    }

    // MARK: - Trait-to-Appearance Mapping

    /// Map warmth score to body color.
    /// High warmth -> warm colors (rose, amber, orange)
    /// Low warmth -> cool colors (cyan, blue, indigo, slate)
    private static func colorFromWarmth(_ warmth: Double) -> String {
        switch warmth {
        case 0.0..<0.2: return "slate"
        case 0.2..<0.35: return "cyan"
        case 0.35..<0.45: return "blue"
        case 0.45..<0.55: return "indigo"
        case 0.55..<0.65: return "violet"
        case 0.65..<0.75: return "pink"
        case 0.75..<0.85: return "amber"
        case 0.85..<0.95: return "rose"
        default: return "orange"
        }
    }

    private static func cheekColorFromWarmth(_ warmth: Double) -> String {
        if warmth > 0.6 { return "rose" }
        if warmth > 0.3 { return "pink" }
        return "slate"
    }

    /// Map formality + playfulness to hat choice
    private static func hatFromTraits(_ traits: AvatarEvolutionState.TraitScores) -> String {
        if traits.formality > 0.7 { return "top_hat" }
        if traits.playfulness > 0.7 { return "cap" }
        if traits.energy > 0.7 { return "beanie" }
        return "none"
    }

    /// Map formality to shirt choice
    private static func shirtFromTraits(_ traits: AvatarEvolutionState.TraitScores) -> String {
        if traits.formality > 0.7 { return "suit" }
        if traits.formality > 0.5 { return "sweater" }
        if traits.playfulness > 0.6 { return "tshirt" }
        return "hoodie"
    }

    /// Map playfulness to accessory choice
    private static func accessoryFromTraits(_ traits: AvatarEvolutionState.TraitScores) -> String {
        if traits.playfulness > 0.7 { return "sunglasses" }
        if traits.formality > 0.7 { return "monocle" }
        if traits.warmth > 0.7 { return "scarf" }
        return "none"
    }

    /// Map energy + playfulness to held item
    private static func heldItemFromTraits(_ traits: AvatarEvolutionState.TraitScores) -> String {
        if traits.energy > 0.7 && traits.playfulness > 0.5 { return "balloon" }
        if traits.formality > 0.7 { return "staff" }
        return "none"
    }
}

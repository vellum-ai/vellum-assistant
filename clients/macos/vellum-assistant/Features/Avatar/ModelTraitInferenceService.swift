import Foundation

/// Infers avatar trait scores from conversation context and identity signals.
/// V1 uses local heuristics. Designed to be swappable with model-based inference later.
@MainActor
final class ModelTraitInferenceService {

    /// Minimum turns between inference runs
    private let checkpointInterval: Int = 2

    /// Last turn number where inference was run
    private var lastInferenceTurn: Int = 0

    /// Run trait inference on the conversation so far.
    /// Returns updated TraitScores, or nil if no inference was needed (too soon since last checkpoint).
    func infer(
        messages: [TraitInferenceMessage],
        identityName: String?,
        identityPersonality: String?,
        identityEmoji: String?,
        currentTurn: Int
    ) -> AvatarEvolutionState.TraitScores? {
        // Only run at checkpoint intervals
        guard currentTurn - lastInferenceTurn >= checkpointInterval else { return nil }
        lastInferenceTurn = currentTurn

        var scores = AvatarEvolutionState.TraitScores()

        // Analyze conversation tone
        let allText = messages.map(\.text).joined(separator: " ").lowercased()

        // Warmth analysis
        scores.warmth = analyzeWarmth(text: allText, personality: identityPersonality)

        // Energy analysis
        scores.energy = analyzeEnergy(text: allText, personality: identityPersonality)

        // Formality analysis
        scores.formality = analyzeFormality(text: allText, personality: identityPersonality)

        // Playfulness analysis
        scores.playfulness = analyzePlayfulness(text: allText, personality: identityPersonality)

        scores.clamp()
        return scores
    }

    /// Reset inference state (e.g., on new conversation)
    func reset() {
        lastInferenceTurn = 0
    }

    // MARK: - Trait Analysis (Local Heuristics)

    private func analyzeWarmth(text: String, personality: String?) -> Double {
        var score = 0.5

        let warmSignals = ["warm", "friendly", "kind", "caring", "sweet", "gentle", "empathetic", "supportive", "encouraging", "love", "heart", "hug", "thank"]
        let coldSignals = ["cold", "analytical", "blunt", "direct", "harsh", "strict", "tough", "clinical", "detached", "distant"]

        score += signalBalance(text: text, positive: warmSignals, negative: coldSignals)

        if let p = personality?.lowercased() {
            score += signalBalance(text: p, positive: warmSignals, negative: coldSignals) * 2.0
        }

        // Emoji usage suggests warmth
        let emojiCount = text.unicodeScalars.filter { $0.properties.isEmoji && !$0.properties.isASCIIHexDigit }.count
        if emojiCount > 3 { score += 0.1 }

        return min(max(score, 0.0), 1.0)
    }

    private func analyzeEnergy(text: String, personality: String?) -> Double {
        var score = 0.5

        let highSignals = ["energetic", "chaotic", "hyper", "excited", "fast", "wild", "intense", "enthusiastic", "dynamic"]
        let lowSignals = ["calm", "steady", "chill", "relaxed", "peaceful", "zen", "quiet", "serene", "measured", "patient"]

        score += signalBalance(text: text, positive: highSignals, negative: lowSignals)

        if let p = personality?.lowercased() {
            score += signalBalance(text: p, positive: highSignals, negative: lowSignals) * 2.0
        }

        // Exclamation marks suggest high energy
        let exclamationRatio = Double(text.filter { $0 == "!" }.count) / max(Double(text.count), 1.0)
        if exclamationRatio > 0.02 { score += 0.1 }

        return min(max(score, 0.0), 1.0)
    }

    private func analyzeFormality(text: String, personality: String?) -> Double {
        var score = 0.5

        let formalSignals = ["formal", "professional", "proper", "sophisticated", "elegant", "refined", "polished", "respectful", "sir", "madam"]
        let casualSignals = ["casual", "laid back", "informal", "chill", "lol", "haha", "nah", "yeah", "dude", "bro", "gonna", "wanna"]

        score += signalBalance(text: text, positive: formalSignals, negative: casualSignals)

        if let p = personality?.lowercased() {
            score += signalBalance(text: p, positive: formalSignals, negative: casualSignals) * 2.0
        }

        // Slang/abbreviations suggest casual
        let slangPatterns = ["lol", "lmao", "omg", "tbh", "imo", "idk", "ngl"]
        let slangCount = slangPatterns.filter { text.contains($0) }.count
        if slangCount > 2 { score -= 0.15 }

        return min(max(score, 0.0), 1.0)
    }

    private func analyzePlayfulness(text: String, personality: String?) -> Double {
        var score = 0.5

        let playfulSignals = ["playful", "fun", "silly", "goofy", "snarky", "witty", "humorous", "joke", "pun", "haha", "lol", "mischievous", "quirky", "weird"]
        let seriousSignals = ["serious", "focused", "no-nonsense", "stern", "grave", "solemn", "stoic", "matter-of-fact", "pragmatic"]

        score += signalBalance(text: text, positive: playfulSignals, negative: seriousSignals)

        if let p = personality?.lowercased() {
            score += signalBalance(text: p, positive: playfulSignals, negative: seriousSignals) * 2.0
        }

        return min(max(score, 0.0), 1.0)
    }

    // MARK: - Helpers

    /// Calculate a balance score from positive and negative signal words.
    /// Returns a value in roughly -0.3 to +0.3 range.
    private func signalBalance(text: String, positive: [String], negative: [String]) -> Double {
        let posCount = positive.filter { matchesWholeWord($0, in: text) }.count
        let negCount = negative.filter { matchesWholeWord($0, in: text) }.count
        let total = posCount + negCount
        guard total > 0 else { return 0.0 }
        return Double(posCount - negCount) / Double(total) * 0.3
    }

    /// Match a signal word using word boundaries to avoid substring collisions
    /// (e.g., "formal" in "informal").
    private func matchesWholeWord(_ word: String, in text: String) -> Bool {
        let pattern = "\\b\(NSRegularExpression.escapedPattern(for: word))\\b"
        return text.range(of: pattern, options: .regularExpression) != nil
    }
}

/// Simple message representation for trait inference.
/// Keeps the service decoupled from specific chat message types.
struct TraitInferenceMessage {
    let role: TraitInferenceRole
    let text: String

    enum TraitInferenceRole {
        case user
        case assistant
    }
}

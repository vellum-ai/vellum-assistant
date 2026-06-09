import Foundation
import VellumAssistantShared

struct InferenceProfileParameterVisibility: Equatable {
    /// `maxTokens` is the provider request's maximum output token budget;
    /// it is intentionally separate from `contextWindow.maxInputTokens`.
    var maxTokens: Bool
    var effort: Bool
    var speed: Bool
    var verbosity: Bool
    var temperature: Bool
    var thinking: Bool
    /// Gemini's reasoning-depth knob (`thinking.level`). Distinct from
    /// `thinking` (Anthropic/OpenRouter enable + stream toggles).
    var thinkingLevel: Bool

    static let none = InferenceProfileParameterVisibility(
        maxTokens: false,
        effort: false,
        speed: false,
        verbosity: false,
        temperature: false,
        thinking: false,
        thinkingLevel: false
    )

    static func resolve(
        provider rawProvider: String?,
        model rawModel: String?,
        isKnownModel _: Bool,
        modelEntry: LLMModelEntry?
    ) -> InferenceProfileParameterVisibility {
        guard
            let provider = rawProvider?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
            !provider.isEmpty,
            let model = rawModel?.trimmingCharacters(in: .whitespacesAndNewlines),
            !model.isEmpty
        else {
            return .none
        }

        let modelId = model.lowercased()
        let usesAnthropicWire = provider == "anthropic" || (provider == "openrouter" && modelId.hasPrefix("anthropic/"))
        let supportsThinking = modelSupportsThinking(
            provider: provider,
            modelId: modelId,
            modelEntry: modelEntry
        )

        return InferenceProfileParameterVisibility(
            maxTokens: true,
            effort: supportsEffort(
                provider: provider,
                modelId: modelId,
                supportsThinking: supportsThinking,
                modelEntry: modelEntry
            ),
            speed: provider == "anthropic" && modelId.contains("opus"),
            verbosity: provider == "openai" && isOpenAIGPT5Family(modelId),
            temperature: usesAnthropicWire,
            thinking: (provider == "anthropic" || provider == "openrouter") && supportsThinking,
            thinkingLevel: provider == "gemini" && supportsThinking
        )
    }

    func sanitized(_ profile: InferenceProfile) -> InferenceProfile {
        var sanitized = profile
        if !maxTokens { sanitized.maxTokens = nil }
        if !effort { sanitized.effort = nil }
        if !speed { sanitized.speed = nil }
        if !verbosity { sanitized.verbosity = nil }
        if !temperature { sanitized.temperature = .unset }
        if !thinking {
            sanitized.thinkingEnabled = nil
            sanitized.thinkingStreamThinking = nil
        }
        if !thinkingLevel { sanitized.thinkingLevel = nil }
        return sanitized
    }

    private static func supportsEffort(
        provider: String,
        modelId: String,
        supportsThinking: Bool,
        modelEntry: LLMModelEntry?
    ) -> Bool {
        switch provider {
        case "anthropic":
            return !modelId.contains("haiku") && supportsThinking
        case "openai":
            return isOpenAIGPT5Family(modelId)
        case "openrouter":
            if modelId.hasPrefix("anthropic/") {
                return !modelId.contains("haiku") && supportsThinking
            }
            return supportsThinking
        case "fireworks":
            return modelEntry?.supportsThinking == true
        default:
            return false
        }
    }

    private static func modelSupportsThinking(
        provider: String,
        modelId: String,
        modelEntry: LLMModelEntry?
    ) -> Bool {
        if let supportsThinking = modelEntry?.supportsThinking {
            return supportsThinking
        }

        switch provider {
        case "anthropic":
            return true
        case "openrouter":
            return knownOpenRouterReasoningModel(modelId)
        default:
            return false
        }
    }

    private static func isOpenAIGPT5Family(_ modelId: String) -> Bool {
        modelId == "gpt-5" || modelId.hasPrefix("gpt-5.") || modelId.hasPrefix("gpt-5-")
    }

    /// Gemini 3.x Pro family accepts only low/medium/high (no "minimal") and
    /// cannot disable thinking. Mirrors the daemon's `isGeminiProModel` in
    /// `assistant/src/providers/gemini/client.ts`.
    private static func isGeminiProModel(_ modelId: String) -> Bool {
        modelId.range(of: #"^gemini-3.*pro"#, options: .regularExpression) != nil
    }

    /// Thinking levels selectable for a Gemini model, lowest → highest. Pro
    /// models omit "minimal". The daemon clamps anything below a model's floor,
    /// so this is a UX nicety rather than a correctness guarantee.
    static func geminiThinkingLevels(_ modelId: String) -> [String] {
        isGeminiProModel(modelId.lowercased())
            ? ["low", "medium", "high"]
            : ["minimal", "low", "medium", "high"]
    }

    private static func knownOpenRouterReasoningModel(_ modelId: String) -> Bool {
        modelId.hasPrefix("anthropic/")
            || modelId.hasPrefix("x-ai/grok-4")
            || modelId.hasPrefix("deepseek/deepseek-r1")
            || modelId == "qwen/qwen3.5-plus-02-15"
            || modelId == "qwen/qwen3.5-397b-a17b"
            || modelId == "moonshotai/kimi-k2.6"
    }
}

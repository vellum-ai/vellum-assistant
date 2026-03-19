import Foundation
import VellumAssistantShared

struct MessageInspectorOverviewContent: Equatable {
    struct Row: Identifiable, Equatable {
        let label: String
        let value: String

        var id: String { label }
    }

    let identityRows: [Row]
    let usageRows: [Row]
    let responsePreview: String?
    let toolCallNames: String?
    let fallbackMessage: String?

    init(entry: LLMRequestLogEntry) {
        guard let summary = entry.summary else {
            identityRows = []
            usageRows = []
            responsePreview = nil
            toolCallNames = nil
            fallbackMessage = MessageInspectorSummaryFormatters.summaryFallbackMessage(
                recordedAt: MessageInspectorSummaryFormatters.formattedCreatedAt(entry.createdAt)
            )
            return
        }

        if MessageInspectorSummaryFormatters.isProviderOnlySummary(summary) {
            identityRows = []
            usageRows = []
            responsePreview = nil
            toolCallNames = nil
            fallbackMessage = MessageInspectorSummaryFormatters.summaryFallbackMessage(
                recordedAt: MessageInspectorSummaryFormatters.formattedCreatedAt(entry.createdAt),
                provider: MessageInspectorSummaryFormatters.displayProvider(summary.provider)
            )
            return
        }

        identityRows = [
            .init(label: "Provider", value: MessageInspectorSummaryFormatters.displayProvider(summary.provider)),
            .init(label: "Model", value: MessageInspectorSummaryFormatters.displayText(summary.model)),
            .init(label: "Created", value: MessageInspectorSummaryFormatters.formattedCreatedAt(entry.createdAt)),
        ]

        usageRows = [
            .init(label: "Input tokens", value: MessageInspectorSummaryFormatters.formatCount(summary.inputTokens)),
            .init(label: "Output tokens", value: MessageInspectorSummaryFormatters.formatCount(summary.outputTokens)),
            .init(label: "Cache tokens", value: MessageInspectorSummaryFormatters.formatCacheTokens(
                created: summary.cacheCreationInputTokens,
                read: summary.cacheReadInputTokens
            )),
            .init(label: "Request messages", value: MessageInspectorSummaryFormatters.formatCount(summary.requestMessageCount)),
            .init(label: "Tool count", value: MessageInspectorSummaryFormatters.formatCount(summary.requestToolCount)),
        ]

        responsePreview = MessageInspectorSummaryFormatters.truncatedResponsePreview(summary.responsePreview)
        toolCallNames = MessageInspectorSummaryFormatters.compactToolNames(summary.toolCallNames)
        fallbackMessage = nil
    }
}

enum MessageInspectorSummaryFormatters {
    static let missingValue = "Unavailable"

    static func formatCount(_ value: Int?) -> String {
        guard let value else { return missingValue }
        return Self.numberFormatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }

    static func formatCacheTokens(created: Int?, read: Int?) -> String {
        var parts: [String] = []

        if let created {
            parts.append("Created \(formatCount(created))")
        }

        if let read {
            parts.append("Read \(formatCount(read))")
        }

        guard !parts.isEmpty else {
            return missingValue
        }

        return parts.joined(separator: ", ")
    }

    static func displayProvider(_ provider: String?) -> String {
        guard let provider = provider?.trimmingCharacters(in: .whitespacesAndNewlines), !provider.isEmpty else {
            return missingValue
        }

        switch provider.lowercased() {
        case "openai":
            return "OpenAI"
        case "anthropic":
            return "Anthropic"
        case "gemini":
            return "Gemini"
        case "openrouter":
            return "OpenRouter"
        case "fireworks":
            return "Fireworks"
        case "ollama":
            return "Ollama"
        default:
            return titleCasedProviderLabel(provider)
        }
    }

    static func displayText(_ value: String?) -> String {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return missingValue
        }
        return value
    }

    static func summaryFallbackMessage(recordedAt: String, provider: String? = nil) -> String {
        if let provider, provider != missingValue {
            return "Normalized summary unavailable for \(provider). Recorded at \(recordedAt). Raw request and response payloads are still available in the Raw tab."
        }

        return "Normalized summary unavailable. Recorded at \(recordedAt). Raw request and response payloads are still available in the Raw tab."
    }

    static func truncatedResponsePreview(_ text: String?, limit: Int = 160) -> String? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            return nil
        }

        guard text.count > limit else {
            return text
        }

        let truncated = String(text.prefix(limit)).trimmingCharacters(in: .whitespacesAndNewlines)
        return truncated.isEmpty ? nil : "\(truncated)…"
    }

    static func compactToolNames(_ names: [String]?, maxVisible: Int = 3) -> String? {
        let cleanedNames = names?
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty } ?? []

        guard !cleanedNames.isEmpty else {
            return nil
        }

        guard cleanedNames.count > maxVisible else {
            return cleanedNames.joined(separator: ", ")
        }

        let visible = cleanedNames.prefix(maxVisible).joined(separator: ", ")
        return "\(visible) +\(cleanedNames.count - maxVisible) more"
    }

    static func formattedCreatedAt(_ epochMs: Int) -> String {
        Date(timeIntervalSince1970: TimeInterval(epochMs) / 1000.0)
            .formatted(date: .abbreviated, time: .shortened)
    }

    static func isProviderOnlySummary(_ summary: LLMCallSummary) -> Bool {
        let hasProvider = displayProvider(summary.provider) != missingValue
        guard hasProvider else { return false }

        return summary.model == nil
            && summary.status == nil
            && summary.inputTokens == nil
            && summary.outputTokens == nil
            && summary.cacheCreationInputTokens == nil
            && summary.cacheReadInputTokens == nil
            && summary.stopReason == nil
            && summary.requestMessageCount == nil
            && summary.requestToolCount == nil
            && summary.responseMessageCount == nil
            && summary.responseToolCallCount == nil
            && summary.responsePreview == nil
            && (summary.toolCallNames?.isEmpty != false)
    }

    private static func titleCasedProviderLabel(_ provider: String) -> String {
        let separators = CharacterSet(charactersIn: "-_")
        let parts = provider
            .lowercased()
            .components(separatedBy: separators)
            .filter { !$0.isEmpty }

        guard !parts.isEmpty else {
            return provider.capitalized
        }

        return parts.map { part in
            part.prefix(1).uppercased() + part.dropFirst()
        }
        .joined(separator: " ")
    }

    private static let numberFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter
    }()
}

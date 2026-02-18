import Foundation

/// Protocol for title generation, allowing platform-specific overrides.
public protocol TitleGenerating: Sendable {
    func generateTitle(for threadId: UUID, firstUserMessage: String) async -> String?
}

/// Consolidated title generator that uses the Anthropic Messages API directly.
///
/// Generates short (3-5 word) titles for chat threads. Thread-safe via actor isolation.
/// Deduplicates requests per thread ID.
public actor TitleGenerator: TitleGenerating {
    public static let shared = TitleGenerator()

    /// Threads for which a title request has already been sent (prevents duplicates).
    private var titledThreads: Set<UUID> = []

    private let model = "claude-haiku-4-5-20251001"

    public init() {}

    /// Generate a short title for the thread's first user message.
    /// Returns nil if no API key is available, if the request fails, or if already titled.
    public func generateTitle(for threadId: UUID, firstUserMessage: String) async -> String? {
        guard !titledThreads.contains(threadId) else { return nil }
        titledThreads.insert(threadId)

        guard let apiKey = resolveAPIKey() else { return nil }

        let prompt = "Reply with a 3-5 word title for a conversation that started with: \(firstUserMessage.prefix(200)). No punctuation."

        var request = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        request.timeoutInterval = 10

        let body: [String: Any] = [
            "model": model,
            "max_tokens": 32,
            "messages": [["role": "user", "content": prompt]]
        ]

        guard let httpBody = try? JSONSerialization.data(withJSONObject: body) else { return nil }
        request.httpBody = httpBody

        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let content = json["content"] as? [[String: Any]],
                  let firstBlock = content.first,
                  let text = firstBlock["text"] as? String else {
                return nil
            }
            let title = text
                .replacingOccurrences(of: "*", with: "")
                .replacingOccurrences(of: "#", with: "")
                .replacingOccurrences(of: "\"", with: "")
                .replacingOccurrences(of: "_", with: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return title.isEmpty ? nil : title
        } catch {
            return nil
        }
    }

    /// Derive a short title from message text, truncated at a word boundary around 50 chars.
    /// Used as a synchronous fallback when the API is unavailable.
    public static func deriveTitle(from text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "New Conversation" }
        if trimmed.count <= 50 { return trimmed }
        let prefix = trimmed.prefix(50)
        if let lastSpace = prefix.lastIndex(of: " ") {
            return String(prefix[prefix.startIndex..<lastSpace]) + "..."
        }
        return String(prefix) + "..."
    }

    /// Resolves the API key from keychain or environment.
    private func resolveAPIKey() -> String? {
        APIKeyManager.shared.getAPIKey(provider: "anthropic")
            ?? ProcessInfo.processInfo.environment["ANTHROPIC_API_KEY"]
    }
}

#if canImport(UIKit)
import Foundation
import VellumAssistantShared

/// Generates short titles for chat threads by sending the first user message
/// to claude-haiku-4-5-20251001 via the Anthropic Messages API.
actor TitleGenerator {
    static let shared = TitleGenerator()

    /// Threads for which a title request has already been sent (prevents duplicates).
    private var titledThreads: Set<UUID> = []

    /// Generate a 3-5 word title for the thread's first user message.
    /// Returns nil if no API key is available, if the request fails, or if already titled.
    func generateTitle(for threadId: UUID, firstUserMessage: String) async -> String? {
        guard !titledThreads.contains(threadId) else { return nil }
        titledThreads.insert(threadId)

        guard let apiKey = APIKeyManager.shared.getAPIKey(provider: "anthropic")
                ?? ProcessInfo.processInfo.environment["ANTHROPIC_API_KEY"] else {
            titledThreads.remove(threadId)
            return nil
        }

        let prompt = "Reply with a 3-5 word title for a conversation that started with: \(firstUserMessage.prefix(200)). No punctuation."

        var request = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")

        let body: [String: Any] = [
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 32,
            "messages": [["role": "user", "content": prompt]]
        ]

        guard let httpBody = try? JSONSerialization.data(withJSONObject: body) else {
            titledThreads.remove(threadId)
            return nil
        }
        request.httpBody = httpBody

        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let content = json["content"] as? [[String: Any]],
                  let firstBlock = content.first,
                  let text = firstBlock["text"] as? String else {
                titledThreads.remove(threadId)
                return nil
            }
            let title = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return title.isEmpty ? nil : title
        } catch {
            titledThreads.remove(threadId)
            return nil
        }
    }
}
#endif

#if canImport(UIKit)
import Foundation
import VellumAssistantShared

/// Generates short titles for chat threads by sending the first user message
/// to claude-haiku-4-5-20251001 via the Anthropic Messages API.
actor TitleGenerator {
    static let shared = TitleGenerator()

    /// Threads for which a title request has already been sent (prevents duplicates).
    private var titledThreads: Set<UUID> = []

    private static let apiURL = URL(string: "https://api.anthropic.com/v1/messages")

    // MARK: - Codable Types

    private struct MessagesRequest: Encodable {
        let model: String
        let max_tokens: Int
        let messages: [Message]

        struct Message: Encodable {
            let role: String
            let content: String
        }
    }

    private struct MessagesResponse: Decodable {
        let content: [ContentBlock]

        struct ContentBlock: Decodable {
            let text: String?
        }
    }

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

        guard let url = Self.apiURL else {
            titledThreads.remove(threadId)
            return nil
        }

        let prompt = "Reply with a 3-5 word title for a conversation that started with: \(firstUserMessage.prefix(200)). No punctuation."

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")

        let body = MessagesRequest(
            model: "claude-haiku-4-5-20251001",
            max_tokens: 32,
            messages: [.init(role: "user", content: prompt)]
        )

        guard let httpBody = try? JSONEncoder().encode(body) else {
            titledThreads.remove(threadId)
            return nil
        }
        request.httpBody = httpBody

        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            let response = try JSONDecoder().decode(MessagesResponse.self, from: data)
            guard let text = response.content.first?.text else {
                titledThreads.remove(threadId)
                return nil
            }
            let title = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if title.isEmpty {
                titledThreads.remove(threadId)
                return nil
            }
            return title
        } catch {
            titledThreads.remove(threadId)
            return nil
        }
    }
}
#endif

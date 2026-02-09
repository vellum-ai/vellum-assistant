import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AnthropicClient")

enum InferenceError: LocalizedError {
    case networkError(String)
    case apiError(statusCode: Int, body: String)
    case parseError(String)
    case noAPIKey

    var errorDescription: String? {
        switch self {
        case .networkError(let msg): return "Network error: \(msg)"
        case .apiError(let code, let body): return "API error (\(code)): \(body)"
        case .parseError(let msg): return "Parse error: \(msg)"
        case .noAPIKey: return "No API key configured"
        }
    }
}

/// Shared HTTP client for the Anthropic Messages API.
/// Handles auth headers, retry with exponential backoff for transient errors,
/// response parsing, and tool_use block extraction.
final class AnthropicClient {
    private let apiKey: String
    private let baseURL = "https://api.anthropic.com/v1/messages"
    private let apiVersion = "2023-06-01"

    /// Maximum number of retry attempts for transient errors.
    private let maxRetries = 2
    /// Initial delay before the first retry (in seconds).
    private let initialRetryDelay: TimeInterval = 1.0
    /// Multiplier applied to the delay after each retry.
    private let backoffFactor: Double = 2.0

    init(apiKey: String) {
        self.apiKey = apiKey
    }

    /// Sends a tool-use request to the Anthropic Messages API and returns
    /// the first `tool_use` block from the response.
    ///
    /// Retries up to `maxRetries` times for transient errors (HTTP 429, 5xx, network timeouts)
    /// with exponential backoff. Client errors (400, 401, 403, etc.) are thrown immediately.
    ///
    /// - Parameters:
    ///   - model: The model identifier (e.g. "claude-sonnet-4-5-20250929").
    ///   - maxTokens: Maximum tokens for the response.
    ///   - system: The system prompt string.
    ///   - tools: Array of tool definition dictionaries.
    ///   - toolChoice: Tool choice dictionary (e.g. `["type": "any"]`).
    ///   - messages: Array of message dictionaries.
    ///   - timeout: HTTP request timeout in seconds.
    /// - Returns: A tuple of `(name, input)` from the first `tool_use` content block.
    /// - Throws: `InferenceError` on failure.
    func sendToolUseRequest(
        model: String,
        maxTokens: Int,
        system: String,
        tools: [[String: Any]],
        toolChoice: [String: Any],
        messages: [[String: Any]],
        timeout: TimeInterval
    ) async throws -> (name: String, input: [String: Any]) {
        let body: [String: Any] = [
            "model": model,
            "max_tokens": maxTokens,
            "system": system,
            "tools": tools,
            "tool_choice": toolChoice,
            "messages": messages
        ]

        let jsonData = try JSONSerialization.data(withJSONObject: body)

        var request = URLRequest(url: URL(string: baseURL)!)
        request.httpMethod = "POST"
        request.httpBody = jsonData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue(apiVersion, forHTTPHeaderField: "anthropic-version")
        request.timeoutInterval = timeout

        var lastError: Error?
        var currentDelay = initialRetryDelay

        for attempt in 0...maxRetries {
            if attempt > 0 {
                log.info("Retry attempt \(attempt)/\(self.maxRetries) after \(String(format: "%.1f", currentDelay))s delay")
                try await Task.sleep(nanoseconds: UInt64(currentDelay * 1_000_000_000))
                currentDelay *= backoffFactor
            }

            let data: Data
            let response: URLResponse
            do {
                (data, response) = try await URLSession.shared.data(for: request)
            } catch {
                // Network-level error (timeout, connection refused, etc.) — retryable
                lastError = InferenceError.networkError(error.localizedDescription)
                log.warning("Network error on attempt \(attempt + 1): \(error.localizedDescription)")
                continue
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                throw InferenceError.networkError("Invalid response")
            }

            let statusCode = httpResponse.statusCode

            if statusCode == 200 {
                return try parseToolUseResponse(data: data)
            }

            let responseBody = String(data: data, encoding: .utf8) ?? "Unknown error"
            let apiError = InferenceError.apiError(statusCode: statusCode, body: responseBody)

            // Determine if this is a transient error worth retrying
            if isTransientError(statusCode: statusCode) {
                lastError = apiError
                log.warning("Transient API error (\(statusCode)) on attempt \(attempt + 1): \(responseBody)")
                continue
            }

            // Client errors (400, 401, 403, etc.) — do not retry
            throw apiError
        }

        throw lastError ?? InferenceError.networkError("Request failed after \(maxRetries + 1) attempts")
    }

    // MARK: - Private

    private func isTransientError(statusCode: Int) -> Bool {
        return statusCode == 429 || (statusCode >= 500 && statusCode <= 599)
    }

    private func parseToolUseResponse(data: Data) throws -> (name: String, input: [String: Any]) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = json["content"] as? [[String: Any]] else {
            throw InferenceError.parseError("Invalid response structure")
        }

        guard let toolUse = content.first(where: { ($0["type"] as? String) == "tool_use" }),
              let toolName = toolUse["name"] as? String,
              let input = toolUse["input"] as? [String: Any] else {
            throw InferenceError.parseError("No tool_use block in response")
        }

        return (name: toolName, input: input)
    }
}

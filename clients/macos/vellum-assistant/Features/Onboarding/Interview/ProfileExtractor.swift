import Foundation
import Observation
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "ProfileExtractor"
)

// MARK: - UserProfile

struct UserProfile: Codable, Sendable {
    let name: String?
    let role: String?
    let goals: [String]?
    let painPoints: [String]?
    let communicationStyle: String?
    let interests: [String]?
    let personality: String?
}

// MARK: - Extraction Response

private struct ExtractionResponse: Codable {
    let profile: UserProfile
    let soul: String
}

// MARK: - ProfileExtractor

/// Extracts a structured user profile from an interview transcript by sending
/// the conversation to a new daemon session with a profile-extraction system prompt.
/// Writes the `soul` field to `~/.vellum/SOUL.md` and stores the profile
/// in UserDefaults for client-side use.
///
/// Designed to run in the background after onboarding completes. Fails silently
/// on any error — logs but does not crash or surface errors to the user.
@Observable
@MainActor
final class ProfileExtractor {

    // MARK: - Dependencies

    private let daemonClient: DaemonClientProtocol

    // MARK: - Init

    init(daemonClient: DaemonClientProtocol) {
        self.daemonClient = daemonClient
    }

    // MARK: - Extraction

    /// Runs profile extraction against the daemon in the background.
    /// Creates a new session with a profile-extraction system prompt, sends the
    /// formatted interview transcript, parses the JSON response, writes SOUL.md,
    /// and stores profile data in UserDefaults.
    func extractProfile(from messages: [InterviewMessage], assistantName: String) async {
        do {
            try await performExtraction(from: messages, assistantName: assistantName)
        } catch {
            log.error("Profile extraction failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Private

    private static let extractionPrompt = """
    You are analyzing a conversation between an AI assistant and a new user.
    Extract a structured profile as JSON with these fields:
    - name: string (if mentioned)
    - role: string (profession/occupation)
    - goals: string[] (what they want to accomplish)
    - painPoints: string[] (what frustrates them)
    - communicationStyle: "casual" | "formal" | "mixed"
    - interests: string[] (topics they care about)
    - personality: string (1-2 sentence description)

    Then generate a SOUL.md section — a natural-language identity prompt for the assistant \
    that incorporates what was learned. Write it as instructions to the assistant about how \
    to interact with THIS specific human. Keep it to 5-8 lines.

    Output ONLY valid JSON in this format:
    {"profile": {...}, "soul": "..."}
    """

    private func performExtraction(from messages: [InterviewMessage], assistantName: String) async throws {
        guard !messages.isEmpty else {
            log.info("No interview messages to extract profile from")
            return
        }

        // Format the transcript.
        let transcript = formatTranscript(messages, assistantName: assistantName)

        // Subscribe to the daemon stream before creating the session
        // so we don't miss the session_info message.
        let stream = daemonClient.subscribe()

        // Create a new extraction session with the system prompt override.
        try daemonClient.send(SessionCreateMessage(
            title: "Profile extraction",
            systemPromptOverride: Self.extractionPrompt,
            maxResponseTokens: 1024
        ))

        // Wait for session creation, send the transcript, and accumulate the response.
        var sessionId: String?
        var accumulated = ""
        // Track whether we've sent the user message and received at least one
        // text delta back. Since `assistant_text_delta` and `message_complete`
        // don't carry a sessionId, we use this flag to avoid acting on events
        // from unrelated concurrent sessions (e.g., a chat the user starts
        // while extraction is running in the background).
        var messageSent = false
        var receivedDelta = false

        for await message in stream {
            switch message {
            case .sessionInfo(let info):
                if sessionId == nil {
                    sessionId = info.sessionId
                    log.info("Extraction session created: \(info.sessionId)")

                    try daemonClient.send(UserMessageMessage(
                        sessionId: info.sessionId,
                        content: "Here is the interview transcript to analyze:\n\n\(transcript)",
                        attachments: nil
                    ))
                    messageSent = true
                }

            case .assistantTextDelta(let delta) where messageSent:
                accumulated += delta.text
                receivedDelta = true

            case .assistantThinkingDelta where messageSent:
                if !receivedDelta {
                    // Thinking deltas from our session also count as evidence
                    // that this session's response has started.
                    receivedDelta = true
                }

            case .messageComplete where receivedDelta:
                log.info("Extraction response complete (\(accumulated.count) chars)")
                processExtractionResponse(accumulated)
                return

            case .messageComplete where messageSent && !receivedDelta:
                // A message_complete arrived after we sent our message but
                // before we received any deltas — this belongs to another
                // session (e.g., the interview finishing). Ignore it.
                log.debug("Ignoring message_complete from unrelated session")

            case .cuError(let error) where error.sessionId == sessionId:
                log.error("Extraction session error: \(error.message)")
                return

            default:
                break
            }
        }

        // Stream ended without completion -- try to use whatever we accumulated.
        if !accumulated.isEmpty {
            log.warning("Extraction stream ended early, attempting to parse partial response")
            processExtractionResponse(accumulated)
        }
    }

    /// Formats interview messages into a readable transcript.
    private func formatTranscript(_ messages: [InterviewMessage], assistantName: String) -> String {
        let name = assistantName.isEmpty ? "Assistant" : assistantName
        return messages.map { msg in
            let speaker = msg.role == .assistant ? name : "User"
            return "\(speaker): \(msg.text)"
        }.joined(separator: "\n\n")
    }

    /// Parses the JSON response, writes SOUL.md, and stores profile data in UserDefaults.
    private func processExtractionResponse(_ responseText: String) {
        guard let jsonData = extractJSON(from: responseText) else {
            log.error("Could not find JSON object in extraction response")
            return
        }

        do {
            let response = try JSONDecoder().decode(ExtractionResponse.self, from: jsonData)
            writeSoulFile(response.soul)
            storeProfile(response.profile)
            log.info("Profile extraction complete — name: \(response.profile.name ?? "unknown")")
        } catch {
            log.error("Failed to decode extraction response: \(error.localizedDescription)")
        }
    }

    /// Extracts JSON from the response text, handling potential markdown code blocks.
    private func extractJSON(from text: String) -> Data? {
        var cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)

        // Strip markdown code block wrappers if present.
        if cleaned.hasPrefix("```json") {
            cleaned = String(cleaned.dropFirst(7))
        } else if cleaned.hasPrefix("```") {
            cleaned = String(cleaned.dropFirst(3))
        }
        if cleaned.hasSuffix("```") {
            cleaned = String(cleaned.dropLast(3))
        }
        cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)

        // Find the first { and last } to extract the JSON object.
        guard let startIdx = cleaned.firstIndex(of: "{"),
              let endIdx = cleaned.lastIndex(of: "}") else {
            return nil
        }

        let jsonString = String(cleaned[startIdx...endIdx])
        return jsonString.data(using: .utf8)
    }

    /// Writes the soul text to `~/.vellum/SOUL.md`.
    private func writeSoulFile(_ soulContent: String) {
        guard !soulContent.isEmpty else {
            log.warning("No soul text to write")
            return
        }

        let vellumDir = NSHomeDirectory() + "/.vellum"
        let soulPath = vellumDir + "/SOUL.md"

        do {
            try FileManager.default.createDirectory(
                atPath: vellumDir,
                withIntermediateDirectories: true,
                attributes: nil
            )
            try soulContent.write(toFile: soulPath, atomically: true, encoding: .utf8)
            log.info("Wrote SOUL.md to \(soulPath)")
        } catch {
            log.error("Failed to write SOUL.md: \(error.localizedDescription)")
        }
    }

    /// Stores the full profile as JSON in UserDefaults.
    private func storeProfile(_ profile: UserProfile) {
        do {
            let data = try JSONEncoder().encode(profile)
            UserDefaults.standard.set(data, forKey: "user.profile")
            log.info("Stored user profile in UserDefaults")
        } catch {
            log.error("Failed to encode profile for UserDefaults: \(error.localizedDescription)")
        }
    }
}

import Foundation
import Observation
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "ProfileExtractor"
)

/// Extracts a structured user profile from an interview transcript by sending
/// the conversation to a new daemon session with a profile-extraction system prompt.
/// Writes the `soul` field to `~/.vellum/SOUL.md` and stores key profile fields
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
    You are analyzing a conversation between an AI assistant and a new user during their first meeting.
    Extract a structured profile from the conversation.

    Output ONLY valid JSON with these fields:
    {
      "role": "their profession or main occupation",
      "goals": ["goal 1", "goal 2"],
      "painPoints": ["frustration 1", "frustration 2"],
      "communicationStyle": "casual or formal or mixed",
      "interests": ["topic 1", "topic 2"],
      "personality": "1-2 sentence personality description",
      "soul": "A 5-8 line natural-language identity prompt for the assistant about how to interact with THIS specific human. Write as instructions to the assistant. Include their name if mentioned."
    }
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
            maxResponseTokens: 1000
        ))

        // Wait for session creation, send the transcript, and accumulate the response.
        var sessionId: String?
        var accumulated = ""

        for await message in stream {
            switch message {
            case .sessionInfo(let info):
                if sessionId == nil {
                    sessionId = info.sessionId
                    log.info("Extraction session created: \(info.sessionId)")

                    try daemonClient.send(UserMessageMessage(
                        sessionId: info.sessionId,
                        content: transcript,
                        attachments: nil
                    ))
                }

            case .assistantTextDelta(let delta) where sessionId != nil:
                accumulated += delta.text

            case .assistantThinkingDelta where sessionId != nil:
                break

            case .messageComplete where sessionId != nil:
                log.info("Extraction response complete (\(accumulated.count) chars)")
                try processResponse(accumulated)
                return

            case .cuError(let error) where error.sessionId == sessionId:
                log.error("Extraction session error: \(error.message)")
                return

            default:
                break
            }
        }

        // Stream ended without completion — try to use whatever we accumulated.
        if !accumulated.isEmpty {
            log.warning("Extraction stream ended early, attempting to parse partial response")
            try processResponse(accumulated)
        }
    }

    /// Formats interview messages into a readable transcript.
    private func formatTranscript(_ messages: [InterviewMessage], assistantName: String) -> String {
        let name = assistantName.isEmpty ? "Assistant" : assistantName
        var lines: [String] = ["Interview transcript:"]
        for msg in messages {
            let speaker = msg.role == .assistant ? name : "User"
            lines.append("\(speaker): \(msg.text)")
        }
        return lines.joined(separator: "\n")
    }

    /// Parses the JSON response, writes SOUL.md, and stores profile data in UserDefaults.
    private func processResponse(_ responseText: String) throws {
        guard let jsonData = extractJSON(from: responseText) else {
            log.error("Could not find JSON object in extraction response")
            return
        }

        let profile = try JSONDecoder().decode(ExtractedProfile.self, from: jsonData)

        // Write SOUL.md
        writeSoulFile(profile.soul)

        // Store profile data in UserDefaults
        storeProfileData(profile)

        log.info("Profile extraction complete — SOUL.md written, UserDefaults updated")
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
    private func writeSoulFile(_ soul: String?) {
        guard let soul, !soul.isEmpty else {
            log.warning("No soul text to write")
            return
        }

        let vellumDir = NSHomeDirectory() + "/.vellum"
        let soulPath = vellumDir + "/SOUL.md"

        do {
            // Ensure the directory exists.
            try FileManager.default.createDirectory(
                atPath: vellumDir,
                withIntermediateDirectories: true,
                attributes: nil
            )

            try soul.write(toFile: soulPath, atomically: true, encoding: .utf8)
            log.info("Wrote SOUL.md to \(soulPath)")
        } catch {
            log.error("Failed to write SOUL.md: \(error.localizedDescription)")
        }
    }

    /// Stores extracted profile fields in UserDefaults.
    private func storeProfileData(_ profile: ExtractedProfile) {
        let defaults = UserDefaults.standard

        if let role = profile.role {
            defaults.set(role, forKey: "userProfile.role")
        }

        if let goals = profile.goals {
            if let data = try? JSONEncoder().encode(goals) {
                defaults.set(data, forKey: "userProfile.goals")
            }
        }

        if let style = profile.communicationStyle {
            defaults.set(style, forKey: "userProfile.communicationStyle")
        }

        if let interests = profile.interests {
            if let data = try? JSONEncoder().encode(interests) {
                defaults.set(data, forKey: "userProfile.interests")
            }
        }
    }
}

// MARK: - Extracted Profile Model

private struct ExtractedProfile: Decodable {
    let role: String?
    let goals: [String]?
    let painPoints: [String]?
    let communicationStyle: String?
    let interests: [String]?
    let personality: String?
    let soul: String?
}

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

@Observable
@MainActor
final class ProfileExtractor {

    private let daemonClient: DaemonClientProtocol

    init(daemonClient: DaemonClientProtocol) {
        self.daemonClient = daemonClient
    }

    /// Extracts a user profile from interview messages by sending the transcript
    /// to a new daemon session for analysis. Writes a SOUL.md file and stores the
    /// profile in UserDefaults. Fails silently on any error.
    func extractProfile(from messages: [InterviewMessage], assistantName: String) async {
        guard !messages.isEmpty else {
            log.info("No interview messages to extract profile from")
            return
        }

        let transcript = formatTranscript(messages, assistantName: assistantName)
        let extractionPrompt = """
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

        Output format:
        {"profile": {...}, "soul": "..."}
        """

        // Subscribe to daemon messages before creating the session so we don't miss anything.
        let stream = daemonClient.subscribe()

        do {
            try daemonClient.send(SessionCreateMessage(
                title: "Profile extraction",
                systemPromptOverride: extractionPrompt,
                maxResponseTokens: 1024
            ))
        } catch {
            log.error("Failed to create extraction session: \(error.localizedDescription)")
            return
        }

        // Wait for session_info to get the session ID, then send the transcript.
        var sessionId: String?
        var accumulated = ""

        for await message in stream {
            switch message {
            case .sessionInfo(let info):
                if sessionId == nil {
                    sessionId = info.sessionId
                    log.info("Extraction session created: \(info.sessionId)")

                    do {
                        try daemonClient.send(UserMessageMessage(
                            sessionId: info.sessionId,
                            content: "Here is the interview transcript to analyze:\n\n\(transcript)",
                            attachments: nil
                        ))
                    } catch {
                        log.error("Failed to send transcript: \(error.localizedDescription)")
                        return
                    }
                }

            case .assistantTextDelta(let delta) where sessionId != nil:
                accumulated += delta.text

            case .assistantThinkingDelta where sessionId != nil:
                break

            case .messageComplete where sessionId != nil:
                log.info("Extraction response complete (\(accumulated.count) chars)")
                processExtractionResponse(accumulated)
                return

            case .cuError(let error) where error.sessionId == sessionId:
                log.error("Extraction session error: \(error.message)")
                return

            default:
                break
            }
        }

        // Stream ended without completion -- try to use whatever we accumulated.
        if !accumulated.isEmpty {
            log.info("Stream ended early, attempting to parse partial response")
            processExtractionResponse(accumulated)
        }
    }

    // MARK: - Private Helpers

    private func formatTranscript(_ messages: [InterviewMessage], assistantName: String) -> String {
        let name = assistantName.isEmpty ? "Assistant" : assistantName
        return messages.map { msg in
            let speaker = msg.role == .assistant ? name : "User"
            return "\(speaker): \(msg.text)"
        }.joined(separator: "\n\n")
    }

    private func processExtractionResponse(_ responseText: String) {
        // Try to extract JSON from the response -- the model may wrap it in markdown code fences.
        let jsonString = extractJSON(from: responseText)

        guard let data = jsonString.data(using: .utf8) else {
            log.error("Failed to convert response to data")
            return
        }

        do {
            let response = try JSONDecoder().decode(ExtractionResponse.self, from: data)
            writeSoulFile(response.soul)
            storeProfile(response.profile)
            log.info("Profile extraction complete — name: \(response.profile.name ?? "unknown")")
        } catch {
            log.error("Failed to decode extraction response: \(error.localizedDescription)")
        }
    }

    /// Extracts a JSON object string from text that may contain markdown code fences.
    private func extractJSON(from text: String) -> String {
        // Try to find JSON between code fences first.
        if let startRange = text.range(of: "```json"),
           let endRange = text.range(of: "```", range: startRange.upperBound..<text.endIndex) {
            return String(text[startRange.upperBound..<endRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        }

        // Try generic code fence.
        if let startRange = text.range(of: "```"),
           let afterStart = text.index(startRange.upperBound, offsetBy: 0, limitedBy: text.endIndex).flatMap({ idx in
               text.range(of: "\n", range: idx..<text.endIndex)
           }),
           let endRange = text.range(of: "```", range: afterStart.upperBound..<text.endIndex) {
            return String(text[afterStart.upperBound..<endRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        }

        // Try to find a raw JSON object.
        if let openBrace = text.firstIndex(of: "{"),
           let closeBrace = text.lastIndex(of: "}") {
            return String(text[openBrace...closeBrace])
        }

        // Fall back to the raw text.
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func writeSoulFile(_ soulContent: String) {
        let homeDir = FileManager.default.homeDirectoryForCurrentUser
        let vellumDir = homeDir.appendingPathComponent(".vellum")
        let soulPath = vellumDir.appendingPathComponent("SOUL.md")

        do {
            // Ensure ~/.vellum/ exists.
            try FileManager.default.createDirectory(at: vellumDir, withIntermediateDirectories: true)
            try soulContent.write(to: soulPath, atomically: true, encoding: .utf8)
            log.info("Wrote SOUL.md to \(soulPath.path)")
        } catch {
            log.error("Failed to write SOUL.md: \(error.localizedDescription)")
        }
    }

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

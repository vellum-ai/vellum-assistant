import Foundation
import VellumAssistantShared
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
    let personality: String
    let userBehavior: String
}

// MARK: - ProfileExtractor

/// Extracts a structured user profile from an interview transcript by sending
/// the conversation to a new daemon session with a profile-extraction system prompt.
/// Merges `personality` and `userBehavior` into `~/.vellum/workspace/SOUL.md` and stores the
/// profile in UserDefaults for client-side use.
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

    Then generate two additional fields based on what you learned:
    - personality: A 2-3 sentence personality description for the assistant that reflects \
    what was learned about this user. Write it as a description of the assistant's personality.
    - userBehavior: 3-5 bullet points (each starting with "- ") describing how the assistant \
    should interact with THIS specific human based on their preferences, communication style, \
    and needs.

    Output ONLY valid JSON in this format:
    {"profile": {...}, "personality": "...", "userBehavior": "- point 1\\n- point 2\\n..."}
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
        try daemonClient.send(ConversationCreateMessage(
            title: "Profile extraction",
            systemPromptOverride: Self.extractionPrompt,
            maxResponseTokens: 1024
        ))

        // Wait for session creation, send the transcript, and accumulate the response.
        // Filter all streaming events by conversationId so we only process deltas and
        // completion from our own extraction session, not from unrelated concurrent
        // sessions (e.g., a chat the user starts while extraction runs).
        var conversationId: String?
        var accumulated = ""

        for await message in stream {
            switch message {
            case .conversationInfo(let info):
                if conversationId == nil {
                    conversationId = info.conversationId
                    log.info("Extraction conversation created: \(info.conversationId)")

                    try daemonClient.send(UserMessageMessage(
                        conversationId: info.conversationId,
                        content: "Here is the interview transcript to analyze:\n\n\(transcript)",
                        attachments: nil
                    ))
                }

            case .assistantTextDelta(let delta) where delta.conversationId == conversationId && conversationId != nil:
                accumulated += delta.text

            case .assistantThinkingDelta where conversationId != nil:
                break

            case .messageComplete(let complete) where complete.conversationId == conversationId && conversationId != nil:
                log.info("Extraction response complete (\(accumulated.count) chars)")
                processExtractionResponse(accumulated)
                return

            case .generationHandoff(let handoff) where handoff.conversationId == conversationId && conversationId != nil:
                log.info("Extraction response complete via handoff (\(accumulated.count) chars)")
                processExtractionResponse(accumulated)
                return

            case .conversationError(let error) where error.conversationId == conversationId:
                log.error("Extraction conversation error (conversation_error): \(error.userMessage)")
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
            updateSoulFile(personality: response.personality, userBehavior: response.userBehavior)
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

    /// Updates `~/.vellum/workspace/SOUL.md` by merging personality and user-behavior
    /// content into the existing file's `## Personality` and `## User-Specific Behavior`
    /// sections rather than overwriting the whole file (which would nuke Core Principles,
    /// Boundaries, Evolution guardrails, etc.).
    ///
    /// If SOUL.md doesn't exist yet, writes a minimal file with just these two sections;
    /// the daemon's `ensurePromptFiles()` will seed the full template on next startup.
    private func updateSoulFile(personality: String, userBehavior: String) {
        let vellumDir = NSHomeDirectory() + "/.vellum/workspace"
        let soulPath = vellumDir + "/SOUL.md"

        do {
            try FileManager.default.createDirectory(
                atPath: vellumDir,
                withIntermediateDirectories: true,
                attributes: nil
            )

            let content: String
            if FileManager.default.fileExists(atPath: soulPath),
               let existing = try? String(contentsOfFile: soulPath, encoding: .utf8) {
                // Merge into existing SOUL.md by replacing section content
                var updated = existing
                updated = replaceSectionContent(in: updated, section: "## Personality", newContent: personality)
                updated = replaceSectionContent(in: updated, section: "## User-Specific Behavior", newContent: userBehavior)
                content = updated
            } else {
                // No existing SOUL.md — write minimal sections
                content = """
                # SOUL

                ## Personality

                \(personality)

                ## User-Specific Behavior

                \(userBehavior)
                """
            }

            try content.write(toFile: soulPath, atomically: true, encoding: .utf8)
            log.info("Updated SOUL.md at \(soulPath)")
        } catch {
            log.error("Failed to update SOUL.md: \(error.localizedDescription)")
        }
    }

    /// Replaces the content of a markdown section (everything between the section heading
    /// and the next `##` heading) with new content, preserving the heading itself.
    private func replaceSectionContent(in text: String, section: String, newContent: String) -> String {
        // Find the section heading
        guard let sectionRange = text.range(of: section) else {
            // Section doesn't exist — append it at the end
            return text.trimmingCharacters(in: .whitespacesAndNewlines) + "\n\n\(section)\n\n\(newContent)\n"
        }

        // Find what comes after this section heading: the next ## heading (or end of file)
        let afterHeadingStr = String(text[sectionRange.upperBound...])
        let nextSectionPattern = #"\n## "#
        let nextSectionOffset: String.Index?
        if let regex = try? NSRegularExpression(pattern: nextSectionPattern),
           let match = regex.firstMatch(
               in: afterHeadingStr,
               range: NSRange(afterHeadingStr.startIndex..., in: afterHeadingStr)
           ),
           let matchRange = Range(match.range, in: afterHeadingStr) {
            // Convert the offset back to the original text index
            let offset = afterHeadingStr.distance(from: afterHeadingStr.startIndex, to: matchRange.lowerBound)
            nextSectionOffset = text.index(sectionRange.upperBound, offsetBy: offset)
        } else {
            nextSectionOffset = nil
        }

        let sectionContentEnd = nextSectionOffset ?? text.endIndex

        // Build replacement: heading + newline + new content + trailing newline
        let replacement = "\(section)\n\n\(newContent)\n"

        var result = text
        let replaceRange = sectionRange.lowerBound..<sectionContentEnd
        result.replaceSubrange(replaceRange, with: replacement)
        return result
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

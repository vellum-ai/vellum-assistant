import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AmbientAnalyzer")

enum AmbientDecision: String, Codable {
    case ignore
    case observe
    case suggest
}

enum SuggestionIcon: String, Codable {
    case cleanup       // trash, inbox cleanup, file organization
    case error         // visible errors, warnings, failures
    case automation    // repetitive tasks, manual work
    case update        // stale items, pending updates
    case organize      // tabs, windows, desktop clutter
    case security      // expired certs, outdated software

    var sfSymbol: String {
        switch self {
        case .cleanup: return "archivebox.fill"
        case .error: return "exclamationmark.triangle.fill"
        case .automation: return "gearshape.2.fill"
        case .update: return "arrow.clockwise.circle.fill"
        case .organize: return "square.grid.2x2.fill"
        case .security: return "shield.lefthalf.filled"
        }
    }

    var tintColor: String {
        switch self {
        case .cleanup: return "blue"
        case .error: return "red"
        case .automation: return "purple"
        case .update: return "orange"
        case .organize: return "teal"
        case .security: return "yellow"
        }
    }
}

struct AmbientSuggestionDetail {
    let title: String
    let icon: SuggestionIcon
    let headlineStat: String?
    let actionSteps: [String]
    let taskDescription: String  // full description sent to startSession
}

struct AmbientAnalysisResult {
    let decision: AmbientDecision
    let observation: String?
    let suggestionDetail: AmbientSuggestionDetail?
    let confidence: Double
    let reasoning: String
}

final class AmbientAnalyzer {
    private let client: AnthropicClient
    private let model = "claude-haiku-4-5-20251001"

    init(apiKey: String) {
        self.client = AnthropicClient(apiKey: apiKey)
    }

    func analyze(ocrText: String, appName: String, windowTitle: String, knowledgeContext: String) async throws -> AmbientAnalysisResult {
        let systemPrompt = """
        You are a background screen-watching assistant. You observe the user's screen via OCR text and decide what to do.

        Your goal is to learn about the user over time AND proactively offer help when you spot problems, clutter, or opportunities to make their life easier.

        DECISION GUIDE:
        - "ignore" — Most screen content is routine. Use this for normal browsing, reading, coding, etc.
        - "observe" — Record a neutral fact about the user's preferences, tools, or workflow. Use this for things that are informational, NOT things that look like problems.
        - "suggest" — Offer to help when you see something that looks like a PROBLEM, not a preference, and you are highly confident (>0.8) it's actionable. Ask yourself: "Is this something the user would want fixed, cleaned up, or improved?" If yes, suggest — don't just observe it.

        WHEN TO SUGGEST (not just observe):
        - Clutter or digital debt: overflowing inboxes, thousands of unread messages, disorganized files, excessive browser tabs
        - Visible errors, warnings, or failed operations
        - Repetitive manual work the agent could automate
        - Stale or forgotten items: old notifications, pending updates, expired subscriptions
        - Anything where the natural human reaction would be "I should really deal with that"

        CRITICAL: Do NOT rationalize problems as "preferences" or "strategies." If someone has 100K unread promotional emails, that's not a "deliberate organization strategy" — that's inbox debt they'd probably like help cleaning up. Be honest about what you see.

        WHEN TO OBSERVE (not suggest):
        - Neutral preferences: dark mode, favorite apps, preferred tools, workflow patterns
        - Facts about the user's work: what projects they're on, technologies they use
        - Habits that are working well and don't need intervention

        CONSTRAINTS:
        - NEVER suggest help for: sensitive/private content (banking, passwords, personal messages), creative flow states (writing, coding in focus), or casual browsing.
        - Keep observations concise (one sentence).
        - Keep suggestions actionable and specific (describe what the computer-use agent should do to help).
        - When suggesting, also provide: a short punchy title (2-4 words), a category icon, an optional headline stat (the key number that jumps out, e.g. "8,312 unread"), and 2-3 short action steps (what the agent will do, each under 10 words).
        - Do NOT observe the same activity repeatedly. If the user is still doing the same thing as a recent observation, choose "ignore" instead.
        - Check the knowledge context below — if a similar observation already exists, do not create a duplicate.
        - Observations should capture NEW learnings about the user, not restate what is already known.
        """

        let userMessage = """
        ACTIVE APPLICATION: \(appName)
        WINDOW TITLE: \(windowTitle)

        SCREEN CONTENT (OCR):
        \(ocrText)

        YOUR KNOWLEDGE ABOUT THIS USER:
        \(knowledgeContext)

        Analyze the current screen and decide what to do.
        """

        let toolDefinition: [String: Any] = [
            "name": "analyze_screen",
            "description": "Analyze the user's screen content and decide whether to ignore, observe, or suggest help.",
            "input_schema": [
                "type": "object",
                "required": ["decision", "confidence", "reasoning"],
                "properties": [
                    "decision": [
                        "type": "string",
                        "enum": ["ignore", "observe", "suggest"],
                        "description": "What to do: ignore (no action), observe (record a learning), suggest (propose help to the user)"
                    ],
                    "observation": [
                        "type": "string",
                        "description": "When decision is 'observe': a concise note about what you learned about the user. Required for 'observe'."
                    ],
                    "suggestion": [
                        "type": "string",
                        "description": "When decision is 'suggest': a full description of what the computer-use agent should do to help. Required for 'suggest'."
                    ],
                    "suggestion_title": [
                        "type": "string",
                        "description": "When decision is 'suggest': a short punchy title, 2-4 words (e.g. 'Inbox Cleanup', 'Fix Build Error', 'Close Stale Tabs'). Required for 'suggest'."
                    ],
                    "suggestion_icon": [
                        "type": "string",
                        "enum": ["cleanup", "error", "automation", "update", "organize", "security"],
                        "description": "When decision is 'suggest': category icon. cleanup=inbox/file cleanup, error=visible errors/warnings, automation=repetitive tasks, update=stale/pending items, organize=tabs/windows/desktop, security=expired certs/outdated software. Required for 'suggest'."
                    ],
                    "headline_stat": [
                        "type": "string",
                        "description": "When decision is 'suggest': optional key metric that jumps out (e.g. '8,312 unread', '47 open tabs', '3 failed builds'). Short, punchy. Omit if no clear number."
                    ],
                    "action_steps": [
                        "type": "array",
                        "items": ["type": "string"],
                        "description": "When decision is 'suggest': 2-3 short action steps describing what the agent will do (each under 10 words, e.g. 'Archive promotional emails older than 30 days'). Required for 'suggest'."
                    ],
                    "confidence": [
                        "type": "number",
                        "description": "How confident you are in this decision (0.0 to 1.0). Suggestions should only be made at >0.8."
                    ],
                    "reasoning": [
                        "type": "string",
                        "description": "Brief explanation of why you chose this decision."
                    ]
                ]
            ]
        ]

        let inferenceResult = try await client.sendToolUseRequest(
            model: model,
            maxTokens: 512,
            system: systemPrompt,
            tools: [toolDefinition],
            toolChoice: ["type": "any"],
            messages: [
                ["role": "user", "content": userMessage]
            ],
            timeout: 15
        )

        let input = inferenceResult.input
        guard let decisionStr = input["decision"] as? String,
              let decision = AmbientDecision(rawValue: decisionStr),
              let confidence = input["confidence"] as? Double,
              let reasoning = input["reasoning"] as? String else {
            throw InferenceError.parseError("Failed to parse analyze_screen tool response")
        }

        // Build rich suggestion detail if this is a suggest decision
        var suggestionDetail: AmbientSuggestionDetail?
        if decision == .suggest, let suggestion = input["suggestion"] as? String {
            let title = input["suggestion_title"] as? String ?? "Suggestion"
            let iconStr = input["suggestion_icon"] as? String ?? "cleanup"
            let icon = SuggestionIcon(rawValue: iconStr) ?? .cleanup
            let headlineStat = input["headline_stat"] as? String
            let actionSteps = input["action_steps"] as? [String] ?? []

            suggestionDetail = AmbientSuggestionDetail(
                title: title,
                icon: icon,
                headlineStat: headlineStat,
                actionSteps: actionSteps,
                taskDescription: suggestion
            )
        }

        let result = AmbientAnalysisResult(
            decision: decision,
            observation: input["observation"] as? String,
            suggestionDetail: suggestionDetail,
            confidence: confidence,
            reasoning: reasoning
        )

        log.info("Analysis: \(decision.rawValue) (confidence: \(String(format: "%.2f", confidence))) — \(reasoning)")
        if let detail = suggestionDetail {
            log.info("Suggestion: \(detail.title) — \(detail.actionSteps.joined(separator: "; "))")
        }
        return result
    }
}

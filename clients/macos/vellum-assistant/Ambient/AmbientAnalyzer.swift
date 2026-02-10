import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AmbientAnalyzer")

enum AmbientDecision: String, Codable {
    case ignore
    case observe
    case suggest
}

struct AmbientAnalysisResult: Codable {
    let decision: AmbientDecision
    let observation: String?
    let suggestion: String?
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
                        "description": "When decision is 'suggest': a specific, actionable description of what the computer-use agent should do to help. Required for 'suggest'."
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

        let result = AmbientAnalysisResult(
            decision: decision,
            observation: input["observation"] as? String,
            suggestion: input["suggestion"] as? String,
            confidence: confidence,
            reasoning: reasoning
        )

        log.info("Analysis: \(decision.rawValue) (confidence: \(String(format: "%.2f", confidence))) — \(reasoning)")
        return result
    }
}

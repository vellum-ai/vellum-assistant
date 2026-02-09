import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AmbientAnalyzer")

enum AmbientDecision: String, Codable {
    case ignore
    case observe
    case suggest
}

struct AmbientAnalysisResult {
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
        You are a background screen-watching assistant. You passively observe the user's screen via OCR text and decide what to do.

        Your goal is to learn about the user over time and occasionally offer proactive help when you spot something genuinely useful.

        RULES:
        - Choose "ignore" ~80% of the time. Most screen content is routine and needs no action.
        - Choose "observe" when you notice something worth remembering about the user's habits, preferences, or workflow.
        - Choose "suggest" ONLY when you are highly confident (>0.8) that you can offer genuinely helpful, actionable assistance. Examples: fixing a visible error message, automating a repetitive task you've seen before, opening a resource related to what they're working on.
        - NEVER suggest help for: sensitive/private content (banking, passwords, personal messages), creative flow states (writing, coding in focus), casual browsing.
        - Keep observations concise (one sentence).
        - Keep suggestions actionable and specific (describe what the computer-use agent should do).
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

        let (_, input) = try await client.sendToolUseRequest(
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

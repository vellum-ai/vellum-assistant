import Foundation
import CoreGraphics

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

final class AnthropicProvider: ActionInferenceProvider {
    private let apiKey: String
    private let model: String
    private let baseURL = "https://api.anthropic.com/v1/messages"
    private let apiVersion = "2023-06-01"

    init(apiKey: String, model: String = "claude-sonnet-4-5-20250929") {
        self.apiKey = apiKey
        self.model = model
    }

    func infer(
        axTree: String?,
        screenshot: Data?,
        screenSize: CGSize,
        task: String,
        history: [ActionRecord],
        elements: [AXElement]?
    ) async throws -> AgentAction {
        let systemPrompt = buildSystemPrompt(screenSize: screenSize)
        let messages = buildMessages(axTree: axTree, screenshot: screenshot, task: task, history: history)

        let body: [String: Any] = [
            "model": model,
            "max_tokens": 1024,
            "system": systemPrompt,
            "tools": ToolDefinitions.tools,
            "tool_choice": ["type": "any"],
            "messages": messages
        ]

        let jsonData = try JSONSerialization.data(withJSONObject: body)

        var request = URLRequest(url: URL(string: baseURL)!)
        request.httpMethod = "POST"
        request.httpBody = jsonData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue(apiVersion, forHTTPHeaderField: "anthropic-version")
        request.timeoutInterval = 30

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw InferenceError.networkError(error.localizedDescription)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw InferenceError.networkError("Invalid response")
        }

        guard httpResponse.statusCode == 200 else {
            let body = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw InferenceError.apiError(statusCode: httpResponse.statusCode, body: body)
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = json["content"] as? [[String: Any]] else {
            throw InferenceError.parseError("Invalid response structure")
        }

        // Find the tool_use block
        guard let toolUse = content.first(where: { ($0["type"] as? String) == "tool_use" }),
              let toolName = toolUse["name"] as? String,
              let input = toolUse["input"] as? [String: Any] else {
            throw InferenceError.parseError("No tool_use block in response")
        }

        return try parseToolCall(name: toolName, input: input, elements: elements)
    }

    // MARK: - System Prompt

    private func buildSystemPrompt(screenSize: CGSize) -> String {
        """
        You are vellum-assistant's computer use agent. You control the user's Mac to accomplish tasks by interacting with UI elements one action at a time.

        The screen is \(Int(screenSize.width))×\(Int(screenSize.height)) pixels.

        You will receive the current screen state as an accessibility tree. Each interactive element has an [ID] number like [3] or [17]. Use these IDs with element_id to target elements — this is much more reliable than pixel coordinates.

        YOUR ONLY AVAILABLE TOOLS ARE: click, double_click, right_click, type_text, key, scroll, wait, done.
        You MUST only call one of these tools each turn. Do NOT attempt to call any other tool.

        RULES:
        - Call exactly one tool per turn. After each action, you'll receive the updated screen state.
        - ALWAYS use element_id to target elements from the accessibility tree. Only fall back to x,y coordinates if no tree is available.
        - Use the wait tool when you need to pause for UI to update (e.g. after clicking a button that loads content).
        - FORM FIELD WORKFLOW: To fill a text field, first click it (by element_id) to focus it, then call type_text. If a field already shows "FOCUSED", skip the click and type immediately.
        - After typing, verify in the next turn that the text appeared correctly.
        - If something unexpected happens, adapt your approach.
        - If you're stuck (same state after 3+ actions), try a different approach or call done with an explanation.
        - NEVER type passwords, credit card numbers, SSNs, or other sensitive data.
        - Prefer keyboard shortcuts (cmd+c, cmd+v) over menu navigation when possible.
        - When the task is complete, call the done tool with a summary.
        """
    }

    // MARK: - Message Building

    private func buildMessages(axTree: String?, screenshot: Data?, task: String, history: [ActionRecord]) -> [[String: Any]] {
        var contentBlocks: [[String: Any]] = []

        // Screenshot image block
        if let screenshotData = screenshot {
            contentBlocks.append([
                "type": "image",
                "source": [
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": screenshotData.base64EncodedString()
                ]
            ])
        }

        // Text block
        var textParts: [String] = []
        textParts.append("TASK: \(task)")
        textParts.append("")

        if let tree = axTree {
            textParts.append("CURRENT SCREEN STATE (accessibility tree of the focused window):")
            textParts.append(tree)
            textParts.append("")
            textParts.append("Use element_id with the [ID] numbers shown above to target elements.")
            if screenshot != nil {
                textParts.append("")
                textParts.append("A screenshot of the FULL SCREEN is also attached above. Use it to see content outside the focused window (e.g., reference documents, PDFs, other apps visible behind the current window). The AX tree only covers the focused window, but the screenshot shows everything visible on screen.")
            }
        } else if screenshot != nil {
            textParts.append("CURRENT SCREEN STATE:")
            textParts.append("See the screenshot above. No accessibility tree available — estimate coordinates from the image.")
        } else {
            textParts.append("CURRENT SCREEN STATE:")
            textParts.append("No screen data available.")
        }

        if !history.isEmpty {
            textParts.append("")
            textParts.append("ACTIONS TAKEN SO FAR:")
            for record in history {
                let result = record.result ?? "executed"
                textParts.append("  \(record.step). \(record.action.displayDescription) → \(result)")
            }
        }

        textParts.append("")
        if history.isEmpty {
            textParts.append("This is the first action. Examine the screen state and decide what to do first.")
        } else {
            textParts.append("Decide the next action to take.")
        }

        contentBlocks.append([
            "type": "text",
            "text": textParts.joined(separator: "\n")
        ])

        return [[
            "role": "user",
            "content": contentBlocks
        ]]
    }

    // MARK: - Tool Call Parsing

    private func parseToolCall(name: String, input: [String: Any], elements: [AXElement]?) throws -> AgentAction {
        let reasoning = input["reasoning"] as? String ?? ""
        let elementId = input["element_id"] as? Int
        let inputX = input["x"] as? Int
        let inputY = input["y"] as? Int

        switch name {
        case "click", "double_click", "right_click":
            let actionType: ActionType = name == "click" ? .click : name == "double_click" ? .doubleClick : .rightClick
            let (x, y, resolvedId, desc) = resolvePosition(elementId: elementId, inputX: inputX, inputY: inputY, elements: elements)
            guard let finalX = x, let finalY = y else {
                throw InferenceError.parseError("\(name) requires element_id or x,y coordinates")
            }
            return AgentAction(
                type: actionType,
                reasoning: reasoning,
                x: CGFloat(finalX),
                y: CGFloat(finalY),
                resolvedFromElementId: resolvedId,
                elementDescription: desc
            )

        case "type_text":
            guard let text = input["text"] as? String else {
                throw InferenceError.parseError("type_text requires 'text' field")
            }
            return AgentAction(type: .type, reasoning: reasoning, text: text)

        case "key":
            guard let key = input["key"] as? String else {
                throw InferenceError.parseError("key requires 'key' field")
            }
            return AgentAction(type: .key, reasoning: reasoning, key: key)

        case "scroll":
            guard let direction = input["direction"] as? String else {
                throw InferenceError.parseError("scroll requires 'direction' field")
            }
            let amount = input["amount"] as? Int ?? 3
            let (x, y, resolvedId, desc) = resolvePosition(elementId: elementId, inputX: inputX, inputY: inputY, elements: elements)
            return AgentAction(
                type: .scroll,
                reasoning: reasoning,
                x: x.map(CGFloat.init) ?? 0,
                y: y.map(CGFloat.init) ?? 0,
                scrollDirection: direction,
                scrollAmount: amount,
                resolvedFromElementId: resolvedId,
                elementDescription: desc
            )

        case "wait":
            guard let durationMs = input["duration_ms"] as? Int else {
                throw InferenceError.parseError("wait requires 'duration_ms' field")
            }
            return AgentAction(type: .wait, reasoning: reasoning, waitDuration: durationMs)

        case "done":
            let summary = input["summary"] as? String ?? "Task completed"
            return AgentAction(type: .done, reasoning: reasoning, summary: summary)

        default:
            throw InferenceError.parseError("Unknown tool: \(name)")
        }
    }

    private func resolvePosition(elementId: Int?, inputX: Int?, inputY: Int?, elements: [AXElement]?) -> (x: Int?, y: Int?, resolvedId: Int?, desc: String?) {
        if let elementId = elementId, let elements = elements {
            let flat = AccessibilityTreeEnumerator.flattenElements(elements)
            if let element = flat.first(where: { $0.id == elementId }) {
                let x = Int(element.frame.midX)
                let y = Int(element.frame.midY)
                let desc = element.title ?? element.roleDescription ?? element.role
                return (x, y, elementId, desc)
            }
        }
        return (inputX, inputY, nil, nil)
    }
}

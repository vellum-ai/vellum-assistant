import Foundation
import CoreGraphics

final class AnthropicProvider: ActionInferenceProvider {
    private let client: AnthropicClient
    private let model: String

    init(apiKey: String, model: String = "claude-sonnet-4-5-20250929") {
        self.client = AnthropicClient(apiKey: apiKey)
        self.model = model
    }

    func infer(
        axTree: String?,
        previousAXTree: String?,
        axDiff: String?,
        secondaryWindows: String?,
        screenshot: Data?,
        screenSize: CGSize,
        task: String,
        history: [ActionRecord],
        elements: [AXElement]?
    ) async throws -> (action: AgentAction, usage: TokenUsage?) {
        let systemPrompt = buildSystemPrompt(screenSize: screenSize)
        let messages = buildMessages(axTree: axTree, previousAXTree: previousAXTree, axDiff: axDiff, secondaryWindows: secondaryWindows, screenshot: screenshot, task: task, history: history)

        let result = try await client.sendToolUseRequest(
            model: model,
            maxTokens: 4096,
            system: systemPrompt,
            tools: ToolDefinitions.tools,
            toolChoice: ["type": "any"],
            messages: messages,
            timeout: 30
        )

        let action = try parseToolCall(name: result.name, input: result.input, elements: elements)
        let usage: TokenUsage?
        if let inputTokens = result.inputTokens, let outputTokens = result.outputTokens {
            usage = TokenUsage(inputTokens: inputTokens, outputTokens: outputTokens)
        } else {
            usage = nil
        }
        return (action: action, usage: usage)
    }

    // MARK: - System Prompt

    private func buildSystemPrompt(screenSize: CGSize) -> String {
        """
        You are vellum-assistant's computer use agent. You control the user's Mac to accomplish tasks by interacting with UI elements one action at a time.

        The screen is \(Int(screenSize.width))×\(Int(screenSize.height)) pixels.

        You will receive the current screen state as an accessibility tree. Each interactive element has an [ID] number like [3] or [17]. Use these IDs with element_id to target elements — this is much more reliable than pixel coordinates.

        YOUR ONLY AVAILABLE TOOLS ARE: click, double_click, right_click, type_text, key, scroll, drag, wait, open_app, done.
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
        - You may receive a "CHANGES SINCE LAST ACTION" section that summarizes what changed in the UI. Use this to confirm your action worked or to adapt.
        - You may see "OTHER VISIBLE WINDOWS" showing elements from other apps. Use this for cross-app tasks (e.g., "copy from Safari, paste into Notes").
        - For drag operations (moving files, resizing, sliders), use the drag tool with source and destination element_ids or coordinates.

        MULTI-STEP WORKFLOWS:
        - When a task involves multiple apps (e.g., "send a message in Slack"), use open_app to switch apps — it is much more reliable than cmd+tab.
        - After switching apps with open_app, wait one turn for the UI to update before interacting with the new app's elements.
        - Break cross-app tasks into phases: (1) open_app to switch, (2) wait for UI, (3) interact with the app.

        APP-SPECIFIC TIPS:
        - Slack: Use cmd+k to quickly jump to a channel or DM by name.
        - Safari / Chrome: Use cmd+l to focus the address bar.
        - VS Code: Use cmd+shift+p to open the command palette.
        - Finder: Use cmd+shift+g for "Go to Folder".
        - Messages: Click the search bar or use cmd+n for a new message.
        """
    }

    // MARK: - Message Building

    private func buildMessages(axTree: String?, previousAXTree: String?, axDiff: String?, secondaryWindows: String?, screenshot: Data?, task: String, history: [ActionRecord]) -> [[String: Any]] {
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

        // Include AX tree diff (compact summary of what changed)
        if let diff = axDiff, !history.isEmpty {
            textParts.append(diff)
            textParts.append("")
        } else if let prevTree = previousAXTree, !history.isEmpty {
            // Fall back to full previous tree if diff unavailable
            textParts.append("SCREEN STATE BEFORE YOUR LAST ACTION:")
            textParts.append(prevTree)
            textParts.append("")
        }

        if let tree = axTree {
            textParts.append("CURRENT SCREEN STATE (accessibility tree of the focused window):")
            textParts.append(tree)
            textParts.append("")
            textParts.append("Use element_id with the [ID] numbers shown above to target elements.")
            // Include secondary windows for cross-app awareness
            if let secWindows = secondaryWindows {
                textParts.append("")
                textParts.append(secWindows)
                textParts.append("")
                textParts.append("Note: The element [ID]s above are from other windows — you can reference them for context but can only interact with the focused window's elements.")
            }

            if screenshot != nil {
                textParts.append("")
                textParts.append("A screenshot of the FULL SCREEN is also attached above. Use it to see content outside the focused window (e.g., reference documents, PDFs, other apps visible behind the current window).")
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
            let maxHistoryEntries = 10
            let windowedHistory: [ActionRecord]
            if history.count > maxHistoryEntries {
                textParts.append("  [... \(history.count - maxHistoryEntries) earlier actions omitted]")
                windowedHistory = Array(history.suffix(maxHistoryEntries))
            } else {
                windowedHistory = history
            }
            for record in windowedHistory {
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

    /// Extract an integer from a JSON value that may be NSNumber (int or double).
    /// Rejects fractional values to avoid silently truncating coordinates/IDs.
    private func intFromJSON(_ value: Any?) -> Int? {
        if let n = value as? Int { return n }
        if let n = value as? NSNumber {
            let d = n.doubleValue
            guard d == d.rounded(.towardZero) && !d.isNaN && !d.isInfinite else { return nil }
            return n.intValue
        }
        return nil
    }

    private func parseToolCall(name: String, input: [String: Any], elements: [AXElement]?) throws -> AgentAction {
        let reasoning = input["reasoning"] as? String ?? ""
        let elementId = intFromJSON(input["element_id"])
        let inputX = intFromJSON(input["x"])
        let inputY = intFromJSON(input["y"])

        switch name {
        case "click", "double_click", "right_click":
            let actionType: ActionType = name == "click" ? .click : name == "double_click" ? .doubleClick : .rightClick
            let (x, y, resolvedId, desc) = resolvePosition(elementId: elementId, inputX: inputX, inputY: inputY, elements: elements)
            guard let finalX = x, let finalY = y else {
                let rawKeys = Array(input.keys).joined(separator: ", ")
                throw InferenceError.parseError("\(name) requires element_id or x,y coordinates (got keys: \(rawKeys), element_id=\(input["element_id"] ?? "nil"), x=\(input["x"] ?? "nil"), y=\(input["y"] ?? "nil"))")
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

        case "drag":
            let toElementId = intFromJSON(input["to_element_id"])
            let inputToX = intFromJSON(input["to_x"])
            let inputToY = intFromJSON(input["to_y"])
            let (fromX, fromY, fromResolvedId, fromDesc) = resolvePosition(elementId: elementId, inputX: inputX, inputY: inputY, elements: elements)
            let (toX, toY, _, _) = resolvePosition(elementId: toElementId, inputX: inputToX, inputY: inputToY, elements: elements)
            guard let finalFromX = fromX, let finalFromY = fromY else {
                throw InferenceError.parseError("drag requires source element_id or x,y coordinates")
            }
            guard let finalToX = toX, let finalToY = toY else {
                throw InferenceError.parseError("drag requires destination to_element_id or to_x,to_y coordinates")
            }
            return AgentAction(
                type: .drag,
                reasoning: reasoning,
                x: CGFloat(finalFromX),
                y: CGFloat(finalFromY),
                toX: CGFloat(finalToX),
                toY: CGFloat(finalToY),
                resolvedFromElementId: fromResolvedId,
                elementDescription: fromDesc
            )

        case "scroll":
            guard let direction = input["direction"] as? String else {
                throw InferenceError.parseError("scroll requires 'direction' field")
            }
            let amount = intFromJSON(input["amount"]) ?? 3
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
            guard let durationMs = intFromJSON(input["duration_ms"]) else {
                throw InferenceError.parseError("wait requires 'duration_ms' field")
            }
            return AgentAction(type: .wait, reasoning: reasoning, waitDuration: durationMs)

        case "open_app":
            guard let appName = input["app_name"] as? String else {
                throw InferenceError.parseError("open_app requires 'app_name' field")
            }
            return AgentAction(type: .openApp, reasoning: reasoning, appName: appName)

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

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
        attachments: [TaskAttachment],
        history: [ActionRecord],
        elements: [AXElement]?,
        consecutiveUnchangedSteps: Int
    ) async throws -> (action: AgentAction, usage: TokenUsage?) {
        let systemPrompt = buildSystemPrompt(screenSize: screenSize)
        let messages = buildMessages(
            axTree: axTree,
            previousAXTree: previousAXTree,
            axDiff: axDiff,
            secondaryWindows: secondaryWindows,
            screenshot: screenshot,
            task: task,
            attachments: attachments,
            history: history,
            consecutiveUnchangedSteps: consecutiveUnchangedSteps
        )

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

    private static func currentDateString() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEEE, MMMM d, yyyy h:mm a"
        return formatter.string(from: Date())
    }

    private func buildSystemPrompt(screenSize: CGSize) -> String {
        """
        You are vellum-assistant's computer use agent. You control the user's Mac to accomplish tasks by interacting with UI elements one action at a time.

        The screen is \(Int(screenSize.width))×\(Int(screenSize.height)) pixels.

        You will receive the current screen state as an accessibility tree. Each interactive element has an [ID] number like [3] or [17]. Use these IDs with element_id to target elements — this is much more reliable than pixel coordinates.

        YOUR ONLY AVAILABLE TOOLS ARE: click, double_click, right_click, type_text, key, scroll, drag, wait, open_app, run_applescript, done, respond.
        You MUST only call one of these tools each turn. Do NOT attempt to call any other tool.

        RULES:
        - Call exactly one tool per turn. After each action, you'll receive the updated screen state.
        - ALWAYS use element_id to target elements from the accessibility tree. Only fall back to x,y coordinates if no tree is available.
        - If the accessibility tree already shows you're in the correct app, do NOT call open_app again — proceed directly with your intended interaction (e.g., click an element, use a keyboard shortcut).
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

        APPLESCRIPT:
        - Use run_applescript when scripting is more reliable than UI clicks — e.g., setting a browser URL, navigating Finder to a path, querying app state, or clicking deeply nested menus.
        - The script result (if any) is returned to you so you can reason about it.
        - NEVER use "do shell script" inside AppleScript — it is blocked for security.
        - Keep scripts short and focused on a single operation.
        - Examples of good use: `tell application "Safari" to set URL of current tab of front window to "https://example.com"`, `tell application "Finder" to open POSIX file "/Users/me/Documents"`.

        CALENDAR / SCHEDULE DATA:
        Today is \(Self.currentDateString()).
        Here are the user's upcoming meetings for today:
        - 10:00 AM — Team Standup (30 min, Google Meet)
        - 2:00 PM — 1:1 with Sarah (30 min, Zoom)
        - 4:00 PM — Sprint Planning (1 hour, Conference Room B)

        If the user is asking a question about their schedule or meetings, use the `respond` tool to answer directly. Do NOT use computer-control tools to open the Calendar app.
        """
    }

    // MARK: - Message Building

    private let maxAttachmentCharsPerFile = 8_000
    private let maxAttachmentCharsTotal = 24_000

    private func buildAttachmentBlocks(_ attachments: [TaskAttachment]) -> [[String: Any]] {
        guard !attachments.isEmpty else { return [] }

        var blocks: [[String: Any]] = []
        let manifest = attachments.enumerated().map { index, attachment in
            "\(index + 1). \(attachment.fileName) (\(attachment.mimeType), \(formatBytes(attachment.sizeBytes)))"
        }
        var textLines: [String] = [
            "ATTACHMENT CONTEXT:",
            "The user attached files to this request.",
            "",
            "Attachment manifest:",
        ]
        textLines.append(contentsOf: manifest)

        let imageCount = attachments.filter { $0.kind == .image }.count
        if imageCount > 0 {
            textLines.append("")
            textLines.append("Included image attachments are attached as image blocks below.")
        }

        let documents = attachments.filter { $0.kind == .document }
        var remainingChars = maxAttachmentCharsTotal
        var addedSnippet = false

        for document in documents {
            guard remainingChars > 0 else { break }
            guard let extracted = document.extractedText?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !extracted.isEmpty else {
                continue
            }

            let cappedPerFile = String(extracted.prefix(maxAttachmentCharsPerFile))
            let finalSnippet = String(cappedPerFile.prefix(remainingChars))
            remainingChars -= finalSnippet.count
            guard !finalSnippet.isEmpty else { continue }

            if !addedSnippet {
                textLines.append("")
                textLines.append("Document text snippets:")
                addedSnippet = true
            }

            textLines.append("")
            textLines.append("--- \(document.fileName) ---")
            if finalSnippet.count < extracted.count {
                textLines.append("\(finalSnippet)\n...[truncated]")
            } else {
                textLines.append(finalSnippet)
            }
        }

        blocks.append([
            "type": "text",
            "text": textLines.joined(separator: "\n")
        ])

        for attachment in attachments where attachment.kind == .image {
            blocks.append([
                "type": "image",
                "source": [
                    "type": "base64",
                    "media_type": attachment.mimeType,
                    "data": attachment.data.base64EncodedString()
                ]
            ])
        }

        return blocks
    }

    private func formatBytes(_ sizeBytes: Int) -> String {
        if sizeBytes < 1024 {
            return "\(sizeBytes) B"
        }
        let kb = Double(sizeBytes) / 1024.0
        if kb < 1024 {
            return String(format: "%.1f KB", kb)
        }
        return String(format: "%.1f MB", kb / 1024.0)
    }

    private func buildMessages(
        axTree: String?,
        previousAXTree: String?,
        axDiff: String?,
        secondaryWindows: String?,
        screenshot: Data?,
        task: String,
        attachments: [TaskAttachment],
        history: [ActionRecord],
        consecutiveUnchangedSteps: Int
    ) -> [[String: Any]] {
        var contentBlocks: [[String: Any]] = []

        // User-provided task attachments are included before screenshot/UI context.
        contentBlocks.append(contentsOf: buildAttachmentBlocks(attachments))

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
        let trimmedTask = task.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedTask.isEmpty {
            textParts.append("TASK: \(trimmedTask)")
        } else if !attachments.isEmpty {
            textParts.append("TASK: Use the attached files as primary context.")
        } else {
            textParts.append("TASK: No explicit task provided.")
        }
        textParts.append("")

        // Include AX tree diff (compact summary of what changed)
        if let diff = axDiff, !history.isEmpty {
            textParts.append(diff)
            textParts.append("")
        } else if previousAXTree != nil && axTree != nil && !history.isEmpty {
            // AX tree unchanged — tell the model its action had no effect
            // (only when we have both current and previous trees; if current tree
            // is nil we fell back to screenshot-only and can't judge)
            let lastAction = history.last
            let wasWait = lastAction?.action.type == .wait
            textParts.append("CHANGES SINCE LAST ACTION:")
            if consecutiveUnchangedSteps >= 2 {
                textParts.append("⚠️ WARNING: \(consecutiveUnchangedSteps) consecutive actions had NO VISIBLE EFFECT on the UI. You MUST try a completely different approach — do not repeat any of your recent actions.")
            } else if !wasWait {
                textParts.append("Your last action (\(lastAction?.action.displayDescription ?? "unknown")) had NO VISIBLE EFFECT on the UI. The screen is identical to the previous step. Do NOT repeat the same action — try something different.")
            } else {
                textParts.append("No visible changes detected — the UI is identical to the previous step.")
            }
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

        case "run_applescript":
            guard let script = input["script"] as? String else {
                throw InferenceError.parseError("run_applescript requires 'script' field")
            }
            return AgentAction(type: .runAppleScript, reasoning: reasoning, script: script)

        case "done":
            let summary = input["summary"] as? String ?? "Task completed"
            return AgentAction(type: .done, reasoning: reasoning, summary: summary)

        case "respond":
            let answer = input["answer"] as? String ?? "No answer provided"
            return AgentAction(type: .respond, reasoning: reasoning, summary: answer)

        default:
            throw InferenceError.parseError("Unknown tool: \(name)")
        }
    }

    /// Resolve an element ID to screen coordinates. `elements` is expected to be pre-flattened.
    private func resolvePosition(elementId: Int?, inputX: Int?, inputY: Int?, elements: [AXElement]?) -> (x: Int?, y: Int?, resolvedId: Int?, desc: String?) {
        if let elementId = elementId, let elements = elements {
            if let element = elements.first(where: { $0.id == elementId }) {
                let x = Int(element.frame.midX)
                let y = Int(element.frame.midY)
                let desc = element.title ?? element.roleDescription ?? element.role
                return (x, y, elementId, desc)
            }
        }
        return (inputX, inputY, nil, nil)
    }
}

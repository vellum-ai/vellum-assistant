import Foundation

// MARK: - Constants

private let maxIterations = 1000
private let maxTestDurationMs = 5 * 60 * 1000 // 5 minutes per test
private let model = "claude-sonnet-4-6"

private let systemPrompt = """
You are a QA test automation agent for a macOS desktop app. Execute test cases and report results.

Tools:
- query_elements: Get the AX tree — shows all interactive elements with IDs, roles, titles, values, and visible text. This is your ONLY way to see the UI.
- click_element: Click element by ID.
- type_into_element: Click + type text into element by ID.
- query_and_click: Query AX tree + click matching element in one step.
- query_and_type: Query AX tree + type into matching element in one step.
- launch_app: Launch the app.
- run_shell, applescript, wait: Fallbacks.
- type_env_var: Type env var value securely (for API keys).
- report_result: Report pass/fail. Call exactly once when done.

Rules:
- NEVER take screenshots. The AX tree has everything you need — element roles, titles, values, and all visible text.
- Use query_and_click / query_and_type to combine discovery + action in one step.
- Use MULTIPLE tool calls per turn (e.g. launch_app + wait together).
- Be DECISIVE. Once you have enough info to judge pass/fail, call report_result immediately.
- When waiting for an app response, wait 5-10s, query_elements once, then judge and report.
- You have a strict 5-minute time limit and a limited iteration budget. Work efficiently.

Efficiency guidelines (CRITICAL — work as fast as possible):
- Do NOT query the full AX tree every single time. Query once when you first encounter a new screen, then reference the elements you found. Only re-query if your element reference fails.
- When waiting for the app or assistant to respond, use a SINGLE wait call of 3-5 seconds, then check. Do not use many short waits.
- If you are stuck on a step for more than 3-4 attempts, report the test as failed rather than continuing to retry.
- Issue the report_result call AS SOON AS you have enough evidence to make a pass/fail determination. Do not perform extra verification beyond what the test requires.
"""

// MARK: - Agent

struct AgentOptions {
    let testContent: String
    let appName: String
    let verbose: Bool
}

func runAgent(options: AgentOptions) async throws -> TestResult {
    guard let apiKey = ProcessInfo.processInfo.environment["ANTHROPIC_API_KEY"] else {
        return TestResult(passed: false, message: "ANTHROPIC_API_KEY environment variable is not set")
    }

    let client = AnthropicClient(apiKey: apiKey)
    let tools = buildToolRegistry(appName: options.appName)
    let definitions = toolDefinitions(from: tools)

    var messages: [Message] = [
        Message(role: "user", content: [.text("Execute the following test case:\n\n\(options.testContent)")])
    ]

    let startTime = Date()

    for iteration in 0..<maxIterations {
        if options.verbose {
            print("  [agent] iteration \(iteration + 1)/\(maxIterations)")
        }

        let request = MessagesRequest(
            model: model,
            max_tokens: 4096,
            system: systemPrompt,
            tools: definitions,
            messages: messages
        )

        let apiStart = Date()
        let response = try await client.createMessage(request: request, verbose: options.verbose)
        let apiMs = Int(Date().timeIntervalSince(apiStart) * 1000)

        // Log assistant content
        if options.verbose {
            let tokens = response.usage.map { "in:\($0.input_tokens ?? 0) out:\($0.output_tokens ?? 0)" } ?? ""
            print("  [agent] API call: \(apiMs)ms \(tokens)")
            for block in response.content {
                switch block {
                case .text(_, let text):
                    print("  [agent] text: \(text)")
                case .toolUse(let id, let name, let input):
                    print("  [agent] tool_use: \(name)(\(input)) [id: \(id)]")
                }
            }
        }

        // Build assistant message content blocks
        var assistantBlocks: [ContentBlock] = []
        for block in response.content {
            switch block {
            case .text(_, let text):
                assistantBlocks.append(.text(text))
            case .toolUse(let id, let name, let input):
                assistantBlocks.append(.toolUse(id: id, name: name, input: input))
            }
        }

        messages.append(Message(role: "assistant", content: assistantBlocks))

        // If stop reason is not tool_use, the agent is done without reporting
        if response.stop_reason != "tool_use" {
            let lastText = response.content.compactMap { block -> String? in
                if case .text(_, let text) = block { return text }
                return nil
            }.joined(separator: "\n")
            return TestResult(
                passed: false,
                message: "Agent stopped without reporting a test result (no report_result call).",
                reasoning: lastText.isEmpty ? "The model produced no text before stopping." : lastText
            )
        }

        // Process tool calls
        var toolResultBlocks: [ContentBlock] = []
        var finalTestResult: TestResult?

        for block in response.content {
            guard case .toolUse(let id, let name, let input) = block else { continue }

            let result = executeTool(name: name, input: input, tools: tools)

            if options.verbose {
                print("  [agent] result: \(result.success ? "ok" : "FAIL") - \(result.data ?? "")")
            }

            toolResultBlocks.append(.toolResult(
                toolUseId: id,
                content: [.text(result.data ?? "")],
                isError: !result.success
            ))

            if let testResult = result.testResult {
                finalTestResult = testResult
            }
        }

        // Build the user message with tool results and optional budget warning
        var userContent = toolResultBlocks

        // Inject budget awareness into the tool results message
        let elapsedMs = Int(Date().timeIntervalSince(startTime) * 1000)
        let remainingIterations = maxIterations - iteration - 1
        let remainingSecs = max(0, (maxTestDurationMs - elapsedMs) / 1000)

        if remainingIterations <= 5 || remainingSecs <= 30 {
            userContent.append(.text("⚠️ URGENT: You have \(remainingIterations) iterations and ~\(remainingSecs)s remaining. You MUST call report_result NOW with your best assessment of pass/fail. Do not perform any more test steps."))
        } else if remainingIterations <= 15 || remainingSecs <= 90 {
            userContent.append(.text("⏱️ Budget check: \(remainingIterations) iterations and ~\(remainingSecs)s remaining. Wrap up your verification and call report_result soon."))
        }

        messages.append(Message(role: "user", content: userContent))

        if let finalResult = finalTestResult {
            return finalResult
        }
    }

    return TestResult(
        passed: false,
        message: "Agent exceeded maximum iterations (\(maxIterations)) without reporting a result.",
        reasoning: "The agent ran for \(maxIterations) iterations without calling report_result. This likely indicates an infinite loop or the agent getting stuck."
    )
}

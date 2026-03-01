import Foundation

// MARK: - Constants

private let maxIterations = 1000
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

    for iteration in 0..<maxIterations {
        if options.verbose {
            print("  [agent] iteration \(iteration + 1)")
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
            return TestResult(
                passed: false,
                message: "Agent stopped without reporting a test result (no report_result call)."
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

        messages.append(Message(role: "user", content: toolResultBlocks))

        if let finalResult = finalTestResult {
            return finalResult
        }
    }

    return TestResult(
        passed: false,
        message: "Agent exceeded maximum iterations (\(maxIterations)) without reporting a result."
    )
}

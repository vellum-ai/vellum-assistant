import Foundation
import AppKit

// MARK: - Test Result

struct TestResult {
    let passed: Bool
    let message: String
}

// MARK: - Tool Result

struct ToolResult {
    let success: Bool
    let data: String?
    let testResult: TestResult?

    static func ok(_ data: String) -> ToolResult {
        ToolResult(success: true, data: data, testResult: nil)
    }

    static func error(_ data: String) -> ToolResult {
        ToolResult(success: false, data: data, testResult: nil)
    }

    static func result(_ testResult: TestResult) -> ToolResult {
        ToolResult(success: true, data: "Test result reported.", testResult: testResult)
    }
}

// MARK: - Tool Protocol

struct Tool {
    let name: String
    let description: String
    let inputSchema: JSONValue
    let execute: ([String: JSONValue]) -> ToolResult
}

// MARK: - Tool Registry

func buildToolRegistry(appName: String) -> [Tool] {
    let executor = ActionExecutor()
    let enumerator = AXTreeEnumerator()

    // Resolve app path: look relative to cwd for the built .app
    let cwd = FileManager.default.currentDirectoryPath
    let candidatePaths = [
        "\(cwd)/../clients/macos/dist/\(appName).app",      // from playwright/agent-xcode
        "\(cwd)/../../clients/macos/dist/\(appName).app",    // from playwright/agent-xcode/.build
        "\(cwd)/clients/macos/dist/\(appName).app",          // from repo root
    ]
    let appPath = candidatePaths
        .map { ($0 as NSString).standardizingPath }
        .first(where: { FileManager.default.fileExists(atPath: $0) })

    return [
        buildQueryElementsTool(enumerator: enumerator, appName: appName),
        buildClickElementTool(executor: executor),
        buildTypeIntoElementTool(executor: executor),
        buildQueryAndClickTool(enumerator: enumerator, executor: executor, appName: appName),
        buildQueryAndTypeTool(enumerator: enumerator, executor: executor, appName: appName),
        buildLaunchAppTool(appName: appName, appPath: appPath),
        buildRunShellTool(),
        buildWaitTool(),
        buildTypeEnvVarTool(executor: executor),
        buildAppleScriptTool(),
        buildReportResultTool(),
    ]
}

func toolDefinitions(from tools: [Tool]) -> [ToolDefinition] {
    tools.map { ToolDefinition(name: $0.name, description: $0.description, input_schema: $0.inputSchema) }
}

func executeTool(name: String, input: [String: JSONValue], tools: [Tool]) -> ToolResult {
    guard let tool = tools.first(where: { $0.name == name }) else {
        return .error("Unknown tool: \(name)")
    }
    return tool.execute(input)
}

// MARK: - Tool Implementations

private func buildQueryElementsTool(enumerator: AXTreeEnumerator, appName: String) -> Tool {
    Tool(
        name: "query_elements",
        description: "Query the accessibility tree of the macOS application to discover interactive elements. Returns a list of elements with IDs that can be used with click_element and type_into_element. ALWAYS call this first before trying to interact with the UI.",
        inputSchema: .object([
            "type": .string("object"),
            "properties": .object([
                "app_name": .object([
                    "type": .string("string"),
                    "description": .string("Name of the app to query. Defaults to the test app."),
                ]),
            ]),
            "required": .array([]),
        ]),
        execute: { input in
            let targetApp = input["app_name"]?.stringValue ?? appName
            guard let result = enumerator.enumerateApp(named: targetApp) else {
                return .error("Could not enumerate app '\(targetApp)'. Is it running?")
            }
            AXTreeEnumerator.writeStateFile(elements: result.elements)
            let formatted = AXTreeEnumerator.formatAXTree(
                elements: result.elements,
                windowTitle: result.windowTitle,
                appName: result.appName
            )
            return .ok(formatted)
        }
    )
}

private func buildClickElementTool(executor: ActionExecutor) -> Tool {
    Tool(
        name: "click_element",
        description: "Click on a UI element by its ID (from query_elements). Use this instead of AppleScript for clicking buttons, checkboxes, etc.",
        inputSchema: .object([
            "type": .string("object"),
            "properties": .object([
                "element_id": .object([
                    "type": .string("integer"),
                    "description": .string("The element ID from query_elements output."),
                ]),
            ]),
            "required": .array([.string("element_id")]),
        ]),
        execute: { input in
            guard let elementId = input["element_id"]?.intValue else {
                return .error("element_id is required and must be an integer")
            }
            guard let point = AXTreeEnumerator.readCoordinates(forElementId: elementId) else {
                return .error("Element \(elementId) not found. Call query_elements first to get fresh element IDs.")
            }
            do {
                try executor.click(at: point)
                return .ok("Clicked element \(elementId) at (\(Int(point.x)), \(Int(point.y)))")
            } catch {
                return .error("Click failed: \(error.localizedDescription)")
            }
        }
    )
}

private func buildTypeIntoElementTool(executor: ActionExecutor) -> Tool {
    Tool(
        name: "type_into_element",
        description: "Click on a UI element to focus it, then type text into it. The text is pasted via clipboard for reliability.",
        inputSchema: .object([
            "type": .string("object"),
            "properties": .object([
                "element_id": .object([
                    "type": .string("integer"),
                    "description": .string("The element ID from query_elements output."),
                ]),
                "text": .object([
                    "type": .string("string"),
                    "description": .string("The text to type into the element."),
                ]),
            ]),
            "required": .array([.string("element_id"), .string("text")]),
        ]),
        execute: { input in
            guard let elementId = input["element_id"]?.intValue else {
                return .error("element_id is required")
            }
            guard let text = input["text"]?.stringValue else {
                return .error("text is required")
            }
            guard let point = AXTreeEnumerator.readCoordinates(forElementId: elementId) else {
                return .error("Element \(elementId) not found. Call query_elements first.")
            }
            do {
                try executor.click(at: point)
                usleep(200_000) // Wait for focus
                try executor.typeText(text)
                return .ok("Typed \(text.count) characters into element \(elementId)")
            } catch {
                return .error("Type failed: \(error.localizedDescription)")
            }
        }
    )
}

private func buildQueryAndClickTool(enumerator: AXTreeEnumerator, executor: ActionExecutor, appName: String) -> Tool {
    Tool(
        name: "query_and_click",
        description: "Query the AX tree and click an element matching a title/role in one step. Saves a round trip vs query_elements + click_element.",
        inputSchema: .object([
            "type": .string("object"),
            "properties": .object([
                "title": .object([
                    "type": .string("string"),
                    "description": .string("Text to match in the element title (case-insensitive substring match)."),
                ]),
                "role": .object([
                    "type": .string("string"),
                    "description": .string("Optional AX role to filter by (e.g. 'button', 'text field'). Matched after stripping 'AX' prefix and lowercasing."),
                ]),
                "app_name": .object([
                    "type": .string("string"),
                    "description": .string("App name to query. Defaults to the test app."),
                ]),
            ]),
            "required": .array([.string("title")]),
        ]),
        execute: { input in
            guard let searchTitle = input["title"]?.stringValue else {
                return .error("title is required")
            }
            let targetApp = input["app_name"]?.stringValue ?? appName
            let roleFilter = input["role"]?.stringValue?.lowercased()

            guard let result = enumerator.enumerateApp(named: targetApp) else {
                return .error("Could not enumerate app '\(targetApp)'. Is it running?")
            }
            AXTreeEnumerator.writeStateFile(elements: result.elements)

            let flat = AXTreeEnumerator.flattenElements(result.elements)
            let searchLower = searchTitle.lowercased()
            let match = flat.first(where: { el in
                let titleMatch = el.title?.lowercased().contains(searchLower) == true
                if let roleFilter = roleFilter {
                    let cleanedRole = el.role.hasPrefix("AX") ? String(el.role.dropFirst(2)).lowercased() : el.role.lowercased()
                    return titleMatch && cleanedRole.contains(roleFilter)
                }
                return titleMatch
            })

            guard let element = match else {
                let formatted = AXTreeEnumerator.formatAXTree(elements: result.elements, windowTitle: result.windowTitle, appName: result.appName)
                return .error("No element matching '\(searchTitle)' found. Current tree:\n\(formatted)")
            }

            let point = CGPoint(x: element.frame.midX, y: element.frame.midY)
            do {
                try executor.click(at: point)
                return .ok("Clicked [\(element.id)] \(element.role) \"\(element.title ?? "")\" at (\(Int(point.x)), \(Int(point.y)))")
            } catch {
                return .error("Click failed: \(error.localizedDescription)")
            }
        }
    )
}

private func buildQueryAndTypeTool(enumerator: AXTreeEnumerator, executor: ActionExecutor, appName: String) -> Tool {
    Tool(
        name: "query_and_type",
        description: "Query the AX tree, find an input element matching a title/placeholder, click it, and type text. Saves multiple round trips.",
        inputSchema: .object([
            "type": .string("object"),
            "properties": .object([
                "title": .object([
                    "type": .string("string"),
                    "description": .string("Text to match in the element title or placeholder (case-insensitive substring)."),
                ]),
                "text": .object([
                    "type": .string("string"),
                    "description": .string("The text to type into the matched element."),
                ]),
                "app_name": .object([
                    "type": .string("string"),
                    "description": .string("App name to query. Defaults to the test app."),
                ]),
            ]),
            "required": .array([.string("title"), .string("text")]),
        ]),
        execute: { input in
            guard let searchTitle = input["title"]?.stringValue else {
                return .error("title is required")
            }
            guard let text = input["text"]?.stringValue else {
                return .error("text is required")
            }
            let targetApp = input["app_name"]?.stringValue ?? appName

            guard let result = enumerator.enumerateApp(named: targetApp) else {
                return .error("Could not enumerate app '\(targetApp)'. Is it running?")
            }
            AXTreeEnumerator.writeStateFile(elements: result.elements)

            let flat = AXTreeEnumerator.flattenElements(result.elements)
            let searchLower = searchTitle.lowercased()
            let match = flat.first(where: { el in
                let titleMatch = el.title?.lowercased().contains(searchLower) == true
                let placeholderMatch = el.placeholderValue?.lowercased().contains(searchLower) == true
                return titleMatch || placeholderMatch
            })

            guard let element = match else {
                let formatted = AXTreeEnumerator.formatAXTree(elements: result.elements, windowTitle: result.windowTitle, appName: result.appName)
                return .error("No element matching '\(searchTitle)' found. Current tree:\n\(formatted)")
            }

            let point = CGPoint(x: element.frame.midX, y: element.frame.midY)
            do {
                try executor.click(at: point)
                usleep(200_000)
                try executor.typeText(text)
                return .ok("Typed \(text.count) chars into [\(element.id)] \(element.role) \"\(element.title ?? element.placeholderValue ?? "")\"")
            } catch {
                return .error("Type failed: \(error.localizedDescription)")
            }
        }
    )
}

private func buildLaunchAppTool(appName: String, appPath: String?) -> Tool {
    Tool(
        name: "launch_app",
        description: "Launch the macOS desktop application under test.",
        inputSchema: .object([
            "type": .string("object"),
            "properties": .object([:]),
            "required": .array([]),
        ]),
        execute: { _ in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            if let appPath = appPath {
                // Use the full path to the built .app to avoid launching a stale installed copy
                process.arguments = ["-a", appPath]
            } else {
                process.arguments = ["-a", appName]
            }
            do {
                try process.run()
                process.waitUntilExit()
                if process.terminationStatus != 0 {
                    return .error("launch failed with exit code \(process.terminationStatus)")
                }
                Thread.sleep(forTimeInterval: 2.0) // Wait for app to launch
                return .ok("Launched \(appPath ?? appName)")
            } catch {
                return .error("Failed to launch app: \(error.localizedDescription)")
            }
        }
    )
}

private func buildRunShellTool() -> Tool {
    Tool(
        name: "run_shell",
        description: "Execute a shell command and return its output. Use for inspecting files, checking process state, etc.",
        inputSchema: .object([
            "type": .string("object"),
            "properties": .object([
                "command": .object([
                    "type": .string("string"),
                    "description": .string("The shell command to execute."),
                ]),
                "timeout_ms": .object([
                    "type": .string("integer"),
                    "description": .string("Timeout in milliseconds. Default: 30000."),
                ]),
            ]),
            "required": .array([.string("command")]),
        ]),
        execute: { input in
            guard let command = input["command"]?.stringValue else {
                return .error("command is required")
            }
            let timeoutMs = input["timeout_ms"]?.intValue ?? 30000

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = ["-c", command]

            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr

            do {
                try process.run()

                // Timeout handling
                let deadline = DispatchTime.now() + .milliseconds(timeoutMs)
                let group = DispatchGroup()
                group.enter()
                DispatchQueue.global().async {
                    process.waitUntilExit()
                    group.leave()
                }
                let result = group.wait(timeout: deadline)
                if result == .timedOut {
                    process.terminate()
                    return .error("Command timed out after \(timeoutMs)ms")
                }

                let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
                let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: stdoutData, encoding: .utf8) ?? ""
                let errorOutput = String(data: stderrData, encoding: .utf8) ?? ""

                if process.terminationStatus != 0 {
                    return .error("Exit code \(process.terminationStatus)\nstdout: \(output)\nstderr: \(errorOutput)")
                }

                return .ok(output + (errorOutput.isEmpty ? "" : "\nstderr: \(errorOutput)"))
            } catch {
                return .error("Failed to run command: \(error.localizedDescription)")
            }
        }
    )
}

private func buildWaitTool() -> Tool {
    Tool(
        name: "wait",
        description: "Wait for a specified number of milliseconds. Use to allow UI to settle after actions.",
        inputSchema: .object([
            "type": .string("object"),
            "properties": .object([
                "ms": .object([
                    "type": .string("integer"),
                    "description": .string("Number of milliseconds to wait."),
                ]),
            ]),
            "required": .array([.string("ms")]),
        ]),
        execute: { input in
            let ms = input["ms"]?.intValue ?? 1000
            Thread.sleep(forTimeInterval: Double(ms) / 1000.0)
            return .ok("Waited \(ms)ms")
        }
    )
}

private func buildTypeEnvVarTool(executor: ActionExecutor) -> Tool {
    Tool(
        name: "type_env_var",
        description: "Type the value of an environment variable into the currently focused input field. The value is never returned in the response — use this for secrets like API keys.",
        inputSchema: .object([
            "type": .string("object"),
            "properties": .object([
                "env_var": .object([
                    "type": .string("string"),
                    "description": .string("The name of the environment variable to type."),
                ]),
                "element_id": .object([
                    "type": .string("integer"),
                    "description": .string("Optional element ID to click before typing (from query_elements)."),
                ]),
            ]),
            "required": .array([.string("env_var")]),
        ]),
        execute: { input in
            guard let envVarName = input["env_var"]?.stringValue else {
                return .error("env_var is required")
            }
            guard let value = ProcessInfo.processInfo.environment[envVarName] else {
                return .error("Environment variable '\(envVarName)' is not set")
            }

            // Optionally click an element first to focus it
            if let elementId = input["element_id"]?.intValue,
               let point = AXTreeEnumerator.readCoordinates(forElementId: elementId) {
                do {
                    try executor.click(at: point)
                    usleep(200_000)
                } catch {
                    return .error("Failed to click element \(elementId): \(error.localizedDescription)")
                }
            }

            do {
                try executor.typeText(value)
                return .ok("Typed value of \(envVarName) (\(value.count) characters)")
            } catch {
                return .error("Failed to type env var: \(error.localizedDescription)")
            }
        }
    )
}

private func buildAppleScriptTool() -> Tool {
    Tool(
        name: "applescript",
        description: "Run an AppleScript. Use this as a fallback for menu bar interactions, drag operations, or complex workflows that can't be done with query_elements/click_element. Prefer the element-based tools for simple clicks and typing.",
        inputSchema: .object([
            "type": .string("object"),
            "properties": .object([
                "script": .object([
                    "type": .string("string"),
                    "description": .string("The AppleScript source to execute."),
                ]),
            ]),
            "required": .array([.string("script")]),
        ]),
        execute: { input in
            guard let script = input["script"]?.stringValue else {
                return .error("script is required")
            }

            // Write script to temp file to avoid escaping issues
            let tempPath = "/tmp/agent-xcode-applescript.scpt"
            do {
                try script.write(toFile: tempPath, atomically: true, encoding: .utf8)
            } catch {
                return .error("Failed to write script file: \(error.localizedDescription)")
            }

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            process.arguments = [tempPath]

            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr

            do {
                try process.run()

                // 30-second timeout
                let group = DispatchGroup()
                group.enter()
                DispatchQueue.global().async {
                    process.waitUntilExit()
                    group.leave()
                }
                let result = group.wait(timeout: .now() + 30)
                if result == .timedOut {
                    process.terminate()
                    return .error("AppleScript timed out after 30 seconds")
                }

                let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
                let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: stdoutData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let errorOutput = String(data: stderrData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

                if process.terminationStatus != 0 {
                    return .error(errorOutput.isEmpty ? "AppleScript failed with exit code \(process.terminationStatus)" : errorOutput)
                }

                return .ok(output.isEmpty ? "AppleScript executed successfully" : output)
            } catch {
                return .error("Failed to run AppleScript: \(error.localizedDescription)")
            }
        }
    )
}

private func buildReportResultTool() -> Tool {
    Tool(
        name: "report_result",
        description: "Report the final test result. Call this exactly once when the test is complete. Pass passed=true if all assertions passed, or passed=false with an explanation if any step failed.",
        inputSchema: .object([
            "type": .string("object"),
            "properties": .object([
                "passed": .object([
                    "type": .string("boolean"),
                    "description": .string("Whether the test passed."),
                ]),
                "message": .object([
                    "type": .string("string"),
                    "description": .string("A message describing the test result."),
                ]),
            ]),
            "required": .array([.string("passed"), .string("message")]),
        ]),
        execute: { input in
            let passed = input["passed"]?.boolValue ?? false
            let message = input["message"]?.stringValue ?? (passed ? "Test passed" : "Test failed")
            return .result(TestResult(passed: passed, message: message))
        }
    )
}

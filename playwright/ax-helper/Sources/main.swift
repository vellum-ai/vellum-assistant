import Foundation
import AppKit

// MARK: - JSON Output Helpers

func jsonSuccess(_ data: String) -> String {
    let escaped = data
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\r", with: "\\r")
        .replacingOccurrences(of: "\t", with: "\\t")
    return "{\"success\":true,\"data\":\"\(escaped)\"}"
}

func jsonError(_ data: String) -> String {
    let escaped = data
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\r", with: "\\r")
        .replacingOccurrences(of: "\t", with: "\\t")
    return "{\"success\":false,\"data\":\"\(escaped)\"}"
}

// MARK: - Argument Parsing

func getArg(_ flag: String) -> String? {
    let args = CommandLine.arguments
    guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
    return args[index + 1]
}

func hasFlag(_ flag: String) -> Bool {
    CommandLine.arguments.contains(flag)
}

// MARK: - State File Path

let stateFilePath: String = {
    if let workerIndex = getArg("--worker") {
        return "/tmp/ax-helper-state-w\(workerIndex).json"
    }
    return "/tmp/ax-helper-state.json"
}()

// MARK: - Commands

let args = CommandLine.arguments
guard args.count >= 2 else {
    print(jsonError("Usage: ax-helper <command> [options]\\nCommands: query, click, type, query-and-click, query-and-type, type-env"))
    exit(1)
}

let command = args[1]
let enumerator = AXTreeEnumerator()
let executor = ActionExecutor()
let defaultAppName = ProcessInfo.processInfo.environment["APP_DISPLAY_NAME"] ?? "Vellum"

switch command {

case "query":
    let appName = getArg("--app") ?? defaultAppName
    guard let result = enumerator.enumerateApp(named: appName) else {
        print(jsonError("Could not enumerate app '\(appName)'. Is it running?"))
        exit(1)
    }
    AXTreeEnumerator.writeStateFile(elements: result.elements, path: stateFilePath)
    let formatted = AXTreeEnumerator.formatAXTree(
        elements: result.elements,
        windowTitle: result.windowTitle,
        appName: result.appName
    )
    print(jsonSuccess(formatted))

case "click":
    if let elementIdStr = getArg("--id"), let elementId = Int(elementIdStr) {
        guard let point = AXTreeEnumerator.readCoordinates(forElementId: elementId, path: stateFilePath) else {
            print(jsonError("Element \(elementId) not found. Run 'query' first to get fresh element IDs."))
            exit(1)
        }
        do {
            try executor.click(at: point)
            print(jsonSuccess("Clicked element \(elementId) at (\(Int(point.x)), \(Int(point.y)))"))
        } catch {
            print(jsonError("Click failed: \(error.localizedDescription)"))
            exit(1)
        }
    } else {
        print(jsonError("--id is required for click"))
        exit(1)
    }

case "type":
    guard let text = getArg("--text") else {
        print(jsonError("--text is required for type"))
        exit(1)
    }
    if let elementIdStr = getArg("--id"), let elementId = Int(elementIdStr) {
        guard let point = AXTreeEnumerator.readCoordinates(forElementId: elementId, path: stateFilePath) else {
            print(jsonError("Element \(elementId) not found. Run 'query' first."))
            exit(1)
        }
        do {
            try executor.click(at: point)
            usleep(200_000)
            try executor.typeText(text)
            print(jsonSuccess("Typed \(text.count) characters into element \(elementId)"))
        } catch {
            print(jsonError("Type failed: \(error.localizedDescription)"))
            exit(1)
        }
    } else {
        do {
            try executor.typeText(text)
            print(jsonSuccess("Typed \(text.count) characters into focused element"))
        } catch {
            print(jsonError("Type failed: \(error.localizedDescription)"))
            exit(1)
        }
    }

case "query-and-click":
    guard let searchTitle = getArg("--title") else {
        print(jsonError("--title is required for query-and-click"))
        exit(1)
    }
    let appName = getArg("--app") ?? defaultAppName
    let roleFilter = getArg("--role")?.lowercased()

    guard let result = enumerator.enumerateApp(named: appName) else {
        print(jsonError("Could not enumerate app '\(appName)'. Is it running?"))
        exit(1)
    }
    AXTreeEnumerator.writeStateFile(elements: result.elements, path: stateFilePath)

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
        print(jsonError("No element matching '\(searchTitle)' found. Current tree:\\n\(formatted)"))
        exit(1)
    }

    let clickPoint = CGPoint(x: element.frame.midX, y: element.frame.midY)
    do {
        try executor.click(at: clickPoint)
        print(jsonSuccess("Clicked [\(element.id)] \(element.role) \"\(element.title ?? "")\" at (\(Int(clickPoint.x)), \(Int(clickPoint.y)))"))
    } catch {
        print(jsonError("Click failed: \(error.localizedDescription)"))
        exit(1)
    }

case "query-and-type":
    guard let searchTitle = getArg("--title") else {
        print(jsonError("--title is required for query-and-type"))
        exit(1)
    }
    guard let text = getArg("--text") else {
        print(jsonError("--text is required for query-and-type"))
        exit(1)
    }
    let appName = getArg("--app") ?? defaultAppName

    guard let result = enumerator.enumerateApp(named: appName) else {
        print(jsonError("Could not enumerate app '\(appName)'. Is it running?"))
        exit(1)
    }
    AXTreeEnumerator.writeStateFile(elements: result.elements, path: stateFilePath)

    let flat = AXTreeEnumerator.flattenElements(result.elements)
    let searchLower = searchTitle.lowercased()
    let match = flat.first(where: { el in
        let titleMatch = el.title?.lowercased().contains(searchLower) == true
        let placeholderMatch = el.placeholderValue?.lowercased().contains(searchLower) == true
        return titleMatch || placeholderMatch
    })

    guard let element = match else {
        let formatted = AXTreeEnumerator.formatAXTree(elements: result.elements, windowTitle: result.windowTitle, appName: result.appName)
        print(jsonError("No element matching '\(searchTitle)' found. Current tree:\\n\(formatted)"))
        exit(1)
    }

    let typePoint = CGPoint(x: element.frame.midX, y: element.frame.midY)
    do {
        try executor.click(at: typePoint)
        usleep(200_000)
        try executor.typeText(text)
        print(jsonSuccess("Typed \(text.count) chars into [\(element.id)] \(element.role) \"\(element.title ?? element.placeholderValue ?? "")\""))
    } catch {
        print(jsonError("Type failed: \(error.localizedDescription)"))
        exit(1)
    }

case "type-env":
    guard let envVarName = getArg("--env-var") else {
        print(jsonError("--env-var is required for type-env"))
        exit(1)
    }
    guard let value = ProcessInfo.processInfo.environment[envVarName] else {
        print(jsonError("Environment variable '\(envVarName)' is not set"))
        exit(1)
    }

    if let elementIdStr = getArg("--id"), let elementId = Int(elementIdStr) {
        guard let point = AXTreeEnumerator.readCoordinates(forElementId: elementId, path: stateFilePath) else {
            print(jsonError("Element \(elementId) not found. Run 'query' first."))
            exit(1)
        }
        do {
            try executor.click(at: point)
            usleep(200_000)
        } catch {
            print(jsonError("Failed to click element \(elementId): \(error.localizedDescription)"))
            exit(1)
        }
    }

    do {
        try executor.typeText(value)
        print(jsonSuccess("Typed value of \(envVarName) (\(value.count) characters)"))
    } catch {
        print(jsonError("Failed to type env var: \(error.localizedDescription)"))
        exit(1)
    }

default:
    print(jsonError("Unknown command: \(command). Available: query, click, type, query-and-click, query-and-type, type-env"))
    exit(1)
}

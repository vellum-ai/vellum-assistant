import CoreGraphics
import AppKit
import ApplicationServices
import os

enum ExecutorError: LocalizedError {
    case eventCreationFailed
    case missingCoordinates
    case missingText
    case missingKey
    case unknownKey(String)
    case accessibilityNotGranted
    case appNotFound(String)
    case appleScriptError(String)
    case appleScriptMissingScript
    case appleScriptTimeout
    case clipboardMismatch

    var errorDescription: String? {
        switch self {
        case .eventCreationFailed: return "Failed to create CGEvent"
        case .missingCoordinates: return "Action requires x,y coordinates"
        case .missingText: return "Type action requires text"
        case .missingKey: return "Key action requires key name"
        case .unknownKey(let key): return "Unknown key: \(key)"
        case .accessibilityNotGranted: return "Accessibility permission not granted"
        case .appNotFound(let name): return "Application not found: \(name)"
        case .appleScriptError(let msg): return "AppleScript error: \(msg)"
        case .appleScriptMissingScript: return "run_applescript requires a script"
        case .appleScriptTimeout: return "AppleScript timed out after 5 seconds"
        case .clipboardMismatch: return "Clipboard contents changed before paste injection; aborting to prevent wrong text from being typed"
        }
    }
}

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ActionExecutor")

final class ActionExecutor {
    private let eventSource: CGEventSource?

    init() {
        eventSource = CGEventSource(stateID: .hidSystemState)
    }

    static func checkAccessibilityPermission(prompt: Bool = false) -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    // MARK: - Mouse Actions

    func click(at point: CGPoint) throws {
        try mouseMove(to: point)
        usleep(30_000)

        guard let mouseDown = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) else {
            throw ExecutorError.eventCreationFailed
        }
        mouseDown.post(tap: .cghidEventTap)
        usleep(50_000)

        guard let mouseUp = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
            throw ExecutorError.eventCreationFailed
        }
        mouseUp.post(tap: .cghidEventTap)
    }

    func doubleClick(at point: CGPoint) throws {
        try click(at: point)
        usleep(100_000)

        guard let mouseDown = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) else {
            throw ExecutorError.eventCreationFailed
        }
        mouseDown.setIntegerValueField(.mouseEventClickState, value: 2)
        mouseDown.post(tap: .cghidEventTap)
        usleep(50_000)

        guard let mouseUp = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
            throw ExecutorError.eventCreationFailed
        }
        mouseUp.setIntegerValueField(.mouseEventClickState, value: 2)
        mouseUp.post(tap: .cghidEventTap)
    }

    func rightClick(at point: CGPoint) throws {
        try mouseMove(to: point)
        usleep(30_000)

        guard let mouseDown = CGEvent(mouseEventSource: eventSource, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right) else {
            throw ExecutorError.eventCreationFailed
        }
        mouseDown.post(tap: .cghidEventTap)
        usleep(50_000)

        guard let mouseUp = CGEvent(mouseEventSource: eventSource, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right) else {
            throw ExecutorError.eventCreationFailed
        }
        mouseUp.post(tap: .cghidEventTap)
    }

    private func mouseMove(to point: CGPoint) throws {
        guard let moveEvent = CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
            throw ExecutorError.eventCreationFailed
        }
        moveEvent.post(tap: .cghidEventTap)
    }

    // MARK: - Keyboard Actions

    func typeText(_ text: String) throws {
        let pasteboard = NSPasteboard.general
        let previousContents = pasteboard.string(forType: .string)

        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        // Capture changeCount immediately after our write, before any sleep or
        // keystroke that frees the thread for other writers. This ensures the
        // baseline reflects only OUR write, not an intervening writer's.
        // Reference: https://developer.apple.com/documentation/appkit/nspasteboard/changecount
        let postWriteChangeCount = pasteboard.changeCount

        // Pre-injection equality check: verify the clipboard now holds exactly
        // what we queued before issuing the paste keystroke. If another process
        // wrote to the clipboard between our setString and this read-back, the
        // paste would inject wrong content — catch that here instead of silently
        // typing unintended text.
        let verifiedContents = pasteboard.string(forType: .string)
        guard verifiedContents == text else {
            // Another process updated the clipboard between our setString and
            // this read-back. We don't know what the current state should be, so
            // restoring previousContents would overwrite that other process's
            // data. Leave the clipboard as-is and surface a clear error.
            log.warning("Clipboard read-back mismatch — another process may have modified the pasteboard; skipping injection")
            throw ExecutorError.clipboardMismatch
        }

        try keyCombo(keyCode: 9, modifiers: .maskCommand) // Cmd+V
        usleep(100_000)

        // Restore clipboard after delay, but only if no one else has written
        // to the pasteboard in the meantime (e.g. the user clicking "Copy").
        let saved = previousContents
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            let pb = NSPasteboard.general
            guard pb.changeCount == postWriteChangeCount else {
                // Another writer (e.g. copy button) claimed the pasteboard — skip restore.
                return
            }
            pb.clearContents()
            if let saved = saved {
                pb.setString(saved, forType: .string)
            }
        }
    }

    func pressKey(_ keyString: String) throws {
        let parts = keyString.lowercased().split(separator: "+").map(String.init)
        var modifiers: CGEventFlags = []
        var keyName = ""

        for part in parts {
            let trimmed = part.trimmingCharacters(in: .whitespaces)
            switch trimmed {
            case "cmd", "command":
                modifiers.insert(.maskCommand)
            case "shift":
                modifiers.insert(.maskShift)
            case "option", "alt":
                modifiers.insert(.maskAlternate)
            case "ctrl", "control":
                modifiers.insert(.maskControl)
            default:
                keyName = trimmed
            }
        }

        guard let keyCode = Self.keyCodeMap[keyName] else {
            throw ExecutorError.unknownKey(keyName)
        }

        try keyCombo(keyCode: keyCode, modifiers: modifiers)
    }

    func keyCombo(keyCode: CGKeyCode, modifiers: CGEventFlags) throws {
        guard let keyDown = CGEvent(keyboardEventSource: eventSource, virtualKey: keyCode, keyDown: true) else {
            throw ExecutorError.eventCreationFailed
        }
        keyDown.flags = modifiers
        keyDown.post(tap: .cghidEventTap)
        usleep(50_000)

        guard let keyUp = CGEvent(keyboardEventSource: eventSource, virtualKey: keyCode, keyDown: false) else {
            throw ExecutorError.eventCreationFailed
        }
        keyUp.flags = modifiers
        keyUp.post(tap: .cghidEventTap)
    }

    // MARK: - Scroll

    func scroll(at point: CGPoint, direction: String, amount: Int) throws {
        try mouseMove(to: point)
        usleep(30_000)

        let multiplier = amount * 5
        var dy: Int32 = 0
        var dx: Int32 = 0

        switch direction.lowercased() {
        case "up": dy = Int32(multiplier)
        case "down": dy = -Int32(multiplier)
        case "left": dx = Int32(multiplier)
        case "right": dx = -Int32(multiplier)
        default: break
        }

        guard let scrollEvent = CGEvent(scrollWheelEvent2Source: eventSource, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else {
            throw ExecutorError.eventCreationFailed
        }
        scrollEvent.post(tap: .cgSessionEventTap)
    }

    // MARK: - Dispatch

    @discardableResult
    func execute(_ action: AgentAction) async throws -> String? {
        switch action.type {
        case .click:
            guard let x = action.x, let y = action.y else { throw ExecutorError.missingCoordinates }
            try click(at: CGPoint(x: x, y: y))
        case .doubleClick:
            guard let x = action.x, let y = action.y else { throw ExecutorError.missingCoordinates }
            try doubleClick(at: CGPoint(x: x, y: y))
        case .rightClick:
            guard let x = action.x, let y = action.y else { throw ExecutorError.missingCoordinates }
            try rightClick(at: CGPoint(x: x, y: y))
        case .type:
            guard let text = action.text else { throw ExecutorError.missingText }
            try typeText(text)
        case .key:
            guard let key = action.key else { throw ExecutorError.missingKey }
            try pressKey(key)
        case .scroll:
            let x = action.x ?? 0
            let y = action.y ?? 0
            let direction = action.scrollDirection ?? "down"
            let amount = action.scrollAmount ?? 3
            try scroll(at: CGPoint(x: x, y: y), direction: direction, amount: amount)
        case .drag:
            guard let fromX = action.x, let fromY = action.y else { throw ExecutorError.missingCoordinates }
            guard let endX = action.toX, let endY = action.toY else { throw ExecutorError.missingCoordinates }
            try drag(from: CGPoint(x: fromX, y: fromY), to: CGPoint(x: endX, y: endY))
        case .openApp:
            guard let appName = action.appName else { throw ExecutorError.appNotFound("(no name)") }
            try await openApp(name: appName)
        case .runAppleScript:
            guard let source = action.script else { throw ExecutorError.appleScriptMissingScript }
            return try await runAppleScript(source)
        case .wait:
            let ms = action.waitDuration ?? 500
            try await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
        case .done, .respond:
            break
        }
        return nil
    }

    // MARK: - AppleScript

    func runAppleScript(_ source: String) async throws -> String? {
        // Run osascript as a subprocess so we can kill it on timeout and avoid blocking the main thread
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", source]

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        try process.run()

        // 5-second timeout — terminate the subprocess if it takes too long
        let timeoutTask = Task {
            try await Task.sleep(nanoseconds: 5_000_000_000)
            if process.isRunning {
                process.terminate()
            }
        }

        return try await withCheckedThrowingContinuation { continuation in
            process.terminationHandler = { proc in
                timeoutTask.cancel()

                let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
                let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: stdoutData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
                let errorOutput = String(data: stderrData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)

                if proc.terminationReason == .uncaughtSignal {
                    continuation.resume(throwing: ExecutorError.appleScriptTimeout)
                } else if proc.terminationStatus != 0 {
                    let message = errorOutput ?? "Unknown AppleScript error (exit \(proc.terminationStatus))"
                    continuation.resume(throwing: ExecutorError.appleScriptError(message))
                } else {
                    continuation.resume(returning: output)
                }
            }
        }
    }

    // MARK: - Drag

    func drag(from startPoint: CGPoint, to endPoint: CGPoint) throws {
        try mouseMove(to: startPoint)
        usleep(30_000)

        guard let mouseDown = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseDown, mouseCursorPosition: startPoint, mouseButton: .left) else {
            throw ExecutorError.eventCreationFailed
        }
        mouseDown.post(tap: .cghidEventTap)
        usleep(50_000)

        // Interpolate drag path for smooth movement
        let steps = 10
        for i in 1...steps {
            let t = CGFloat(i) / CGFloat(steps)
            let point = CGPoint(
                x: startPoint.x + (endPoint.x - startPoint.x) * t,
                y: startPoint.y + (endPoint.y - startPoint.y) * t
            )
            guard let dragEvent = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left) else {
                throw ExecutorError.eventCreationFailed
            }
            dragEvent.post(tap: .cghidEventTap)
            usleep(10_000)
        }

        guard let mouseUp = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseUp, mouseCursorPosition: endPoint, mouseButton: .left) else {
            throw ExecutorError.eventCreationFailed
        }
        mouseUp.post(tap: .cghidEventTap)
    }

    // MARK: - Open App

    static let appAliases: [String: String] = [
        "chrome": "Google Chrome",
        "vs code": "Visual Studio Code",
        "vscode": "Visual Studio Code",
        "edge": "Microsoft Edge",
        "word": "Microsoft Word",
        "excel": "Microsoft Excel",
        "powerpoint": "Microsoft PowerPoint",
        "outlook": "Microsoft Outlook",
        "teams": "Microsoft Teams",
        "iterm": "iTerm",
    ]

    func openApp(name: String) async throws {
        let workspace = NSWorkspace.shared

        // 1. Check running apps for exact or case-insensitive match
        let nameLower = name.lowercased()
        if let runningApp = workspace.runningApplications.first(where: {
            $0.localizedName?.lowercased() == nameLower
        }) {
            runningApp.activate()
            try await Task.sleep(nanoseconds: 300_000_000) // 300ms for app to come forward
            return
        }

        // 2. Resolve aliases
        let resolvedName = Self.appAliases[nameLower] ?? name

        // 3. Search common application directories
        let searchDirs = [
            "/Applications",
            "/System/Applications",
            "/System/Applications/Utilities",
            NSString("~/Applications").expandingTildeInPath,
        ]

        for dir in searchDirs {
            let appPath = "\(dir)/\(resolvedName).app"
            let appURL = URL(fileURLWithPath: appPath)
            if FileManager.default.fileExists(atPath: appPath) {
                let config = NSWorkspace.OpenConfiguration()
                config.activates = true
                try await workspace.openApplication(at: appURL, configuration: config)
                return
            }
        }

        // 4. Try case-insensitive filesystem search in /Applications
        if let found = try? FileManager.default.contentsOfDirectory(atPath: "/Applications")
            .first(where: {
                $0.lowercased() == "\(resolvedName.lowercased()).app"
            }) {
            let appURL = URL(fileURLWithPath: "/Applications/\(found)")
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            try await workspace.openApplication(at: appURL, configuration: config)
            return
        }

        throw ExecutorError.appNotFound(name)
    }

    // MARK: - Key Code Map

    static let keyCodeMap: [String: CGKeyCode] = [
        "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
        "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35,
        "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7,
        "y": 16, "z": 6,
        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26,
        "8": 28, "9": 25,
        "enter": 36, "return": 36, "tab": 48, "space": 49, "escape": 53, "esc": 53,
        "backspace": 51, "delete": 51, "forwarddelete": 117,
        "up": 126, "down": 125, "left": 123, "right": 124,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
        "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42, ";": 41, "'": 39,
        ",": 43, ".": 47, "/": 44, "`": 50,
    ]
}

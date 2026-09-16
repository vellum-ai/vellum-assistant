import CoreGraphics
import AppKit
import ApplicationServices
import MacHelperCore
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

private let log = Logger(subsystem: "ai.vellum.mac-helper", category: "ActionExecutor")

final class ActionExecutor {
    private let eventSource: CGEventSource?

    init() {
        eventSource = CGEventSource(stateID: .hidSystemState)
    }

    // MARK: - Yielding to the user

    /// What the runner reports when it stands down. Reaches the model verbatim
    /// as `executionError`, so it has to say what happened and what to do next.
    static let userIsActiveMessage = "The user is using the keyboard or mouse right now. Nothing was done. Wait for them to finish, then retry."

    /// When we last posted an event of our own. Static because a fresh
    /// `ActionExecutor` is built for every computer-use step, and the post this
    /// has to recognize is usually the previous step's, not this one's. Locked
    /// because posts happen inside the nonisolated `execute` while the runner
    /// reads it from the main actor, and two steps can interleave.
    private static let lastSyntheticPostAt = OSAllocatedUnfairLock<Date?>(initialState: nil)
    /// When the latest synthetic span began. A posted event is an instant, so
    /// it leaves this nil; an input-driving AppleScript emits its events at
    /// unknown points while it runs, so its whole run is the span.
    private static let syntheticSpanStart = OSAllocatedUnfairLock<Date?>(initialState: nil)

    /// Every synthetic event goes through here so the last-post clock can never
    /// drift out of sync with what we actually put on the wire.
    private func postSynthetic(_ event: CGEvent, tap: CGEventTapLocation = .cghidEventTap) {
        event.post(tap: tap)
        Self.syntheticSpanStart.withLock { $0 = nil }
        Self.lastSyntheticPostAt.withLock { $0 = Date() }
    }

    /// `kCGAnyInputEventType`, which no Swift overlay constant exposes. Asking
    /// about one event type at a time misses whichever kinds are left off the
    /// list: a drag past the quiet window reports `.leftMouseDragged` and not
    /// `.mouseMoved`, so watching moves and clicks alone would call a person
    /// who is mid-gesture idle and inject into the gesture.
    private static let anyInputEventType = CGEventType(rawValue: ~UInt32(0))!

    /// The modifiers a person holds as part of a gesture. Caps Lock stays out
    /// because it latches for whole sessions.
    private static let heldModifierMask: CGEventFlags = [.maskCommand, .maskShift, .maskAlternate, .maskControl]

    /// True when the person at the machine is typing, moving the mouse, or
    /// holding a button or modifier right now, which is when we should stand
    /// down rather than fight them for it. Our own posts pair every button
    /// down with an up, but steps overlap, and a synthetic shortcut's flags may
    /// still read as held after it returns, so both are judged by
    /// `UserActivityGate.heldByUser` against our last post.
    static func userIsCurrentlyActive() -> Bool {
        let state = CGEventSourceStateID.combinedSessionState
        let now = Date()
        let lastPost = lastSyntheticPostAt.withLock { $0 }
        let secondsSinceLastInput = CGEventSource.secondsSinceLastEventType(
            state,
            eventType: anyInputEventType
        )
        let buttonHeld = UserActivityGate.heldByUser(
            now: now,
            inputDown: [CGMouseButton.left, .right, .center].contains {
                CGEventSource.buttonState(state, button: $0)
            },
            secondsSinceLastChange: [CGEventType.leftMouseDown, .rightMouseDown, .otherMouseDown]
                .map { CGEventSource.secondsSinceLastEventType(state, eventType: $0) }
                .min() ?? .greatestFiniteMagnitude,
            lastSyntheticPostAt: lastPost
        )
        let modifierHeld = UserActivityGate.heldByUser(
            now: now,
            inputDown: !CGEventSource.flagsState(state).intersection(heldModifierMask).isEmpty,
            secondsSinceLastChange: CGEventSource.secondsSinceLastEventType(state, eventType: .flagsChanged),
            lastSyntheticPostAt: lastPost
        )
        return UserActivityGate.userIsActive(
            now: now,
            lastSyntheticPostAt: lastPost,
            secondsSinceLastInput: secondsSinceLastInput,
            buttonHeld: buttonHeld,
            modifierHeld: modifierHeld,
            syntheticSpanStart: syntheticSpanStart.withLock { $0 }
        )
    }

    /// Whether running `action` takes the machine away from whoever is using
    /// it. Posting to the global tap does, and so does activating an app: it
    /// moves keyboard focus, so the next thing the user types lands somewhere
    /// they were not looking. `runAppleScript` is gated only when the script
    /// drives System Events or activates an app. Otherwise it asks an app to do
    /// something instead of seizing the input devices, and gating it would
    /// leave the polite route as blocked as the rude one.
    static func takesOverFromUser(_ action: AgentAction) -> Bool {
        switch action.type {
        case .click, .doubleClick, .rightClick, .type, .key, .scroll, .drag, .openApp:
            return true
        case .runAppleScript:
            return action.script.map(AppleScriptInputTakeover.takesOver(script:)) ?? false
        case .wait, .done, .respond:
            return false
        }
    }

    // MARK: - Giving the pointer back

    /// Where the person's pointer was before this task first moved it, and
    /// where the task last put it. The pointer stays where an action leaves it
    /// while the task runs, because hover-revealed controls (Slack's message
    /// actions, most web toolbars) disappear the moment it leaves. It goes
    /// home when the task says it is done, or once no pointer action has come
    /// for `pointerReturnDelay`.
    private struct PointerHome {
        var home: CGPoint
        var placed: CGPoint
        var generation: Int
    }

    private static let pointerHome = OSAllocatedUnfairLock<PointerHome?>(initialState: nil)
    static let pointerReturnDelay: TimeInterval = 10

    /// Records that the task is putting the pointer at `point`, saving the
    /// person's position on the first move, and schedules the return.
    private static func notePointerPlaced(at point: CGPoint) {
        let current = CGEvent(source: nil)?.location
        let generation = pointerHome.withLock { state -> Int? in
            if var existing = state {
                existing.placed = point
                existing.generation += 1
                state = existing
                return existing.generation
            }
            guard let current else { return nil }
            state = PointerHome(home: current, placed: point, generation: 0)
            return 0
        }
        guard let generation else { return }
        DispatchQueue.global().asyncAfter(deadline: .now() + pointerReturnDelay) {
            returnPointerHome(ifGeneration: generation)
        }
    }

    /// Puts the pointer back where the person left it. With a generation, only
    /// if no pointer action has happened since that one was scheduled. If the
    /// pointer is no longer where the task put it, the person has taken the
    /// mouse back, so it is theirs and stays put.
    static func returnPointerHome(ifGeneration generation: Int? = nil) {
        let state = pointerHome.withLock { state -> PointerHome? in
            guard let existing = state, generation == nil || existing.generation == generation else { return nil }
            state = nil
            return existing
        }
        guard let state, let current = CGEvent(source: nil)?.location else { return }
        guard abs(current.x - state.placed.x) <= 2, abs(current.y - state.placed.y) <= 2 else { return }
        CGWarpMouseCursorPosition(state.home)
        CGAssociateMouseAndMouseCursorPosition(1)
        lastSyntheticPostAt.withLock { $0 = Date() }
    }

    static func checkAccessibilityPermission(prompt: Bool = false) -> Bool {
        let promptKey = "AXTrustedCheckOptionPrompt" as CFString
        let options = [promptKey: prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    // MARK: - Mouse Actions

    func click(at point: CGPoint) throws {
        try mouseMove(to: point)
        usleep(30_000)

        guard let mouseDown = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) else {
            throw ExecutorError.eventCreationFailed
        }
        postSynthetic(mouseDown)
        usleep(50_000)

        guard let mouseUp = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
            throw ExecutorError.eventCreationFailed
        }
        postSynthetic(mouseUp)
    }

    func doubleClick(at point: CGPoint) throws {
        try click(at: point)
        usleep(100_000)

        guard let mouseDown = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) else {
            throw ExecutorError.eventCreationFailed
        }
        mouseDown.setIntegerValueField(.mouseEventClickState, value: 2)
        postSynthetic(mouseDown)
        usleep(50_000)

        guard let mouseUp = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
            throw ExecutorError.eventCreationFailed
        }
        mouseUp.setIntegerValueField(.mouseEventClickState, value: 2)
        postSynthetic(mouseUp)
    }

    func rightClick(at point: CGPoint) throws {
        try mouseMove(to: point)
        usleep(30_000)

        guard let mouseDown = CGEvent(mouseEventSource: eventSource, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right) else {
            throw ExecutorError.eventCreationFailed
        }
        postSynthetic(mouseDown)
        usleep(50_000)

        guard let mouseUp = CGEvent(mouseEventSource: eventSource, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right) else {
            throw ExecutorError.eventCreationFailed
        }
        postSynthetic(mouseUp)
    }

    private func mouseMove(to point: CGPoint) throws {
        Self.notePointerPlaced(at: point)
        guard let moveEvent = CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
            throw ExecutorError.eventCreationFailed
        }
        postSynthetic(moveEvent)
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
        postSynthetic(keyDown)
        usleep(50_000)

        guard let keyUp = CGEvent(keyboardEventSource: eventSource, virtualKey: keyCode, keyDown: false) else {
            throw ExecutorError.eventCreationFailed
        }
        keyUp.flags = modifiers
        postSynthetic(keyUp)
    }

    // MARK: - Scroll

    /// Scrolls at `point`, or wherever the pointer already is when `point` is
    /// nil, which leaves the pointer alone.
    func scroll(at point: CGPoint?, direction: String, amount: Int) throws {
        if let point {
            try mouseMove(to: point)
            usleep(30_000)
        }

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
        postSynthetic(scrollEvent, tap: .cgSessionEventTap)
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
            let point = action.x.flatMap { x in action.y.map { CGPoint(x: x, y: $0) } }
            let direction = action.scrollDirection ?? "down"
            let amount = action.scrollAmount ?? 3
            try scroll(at: point, direction: direction, amount: amount)
        case .drag:
            guard let fromX = action.x, let fromY = action.y else { throw ExecutorError.missingCoordinates }
            guard let endX = action.toX, let endY = action.toY else { throw ExecutorError.missingCoordinates }
            try drag(from: CGPoint(x: fromX, y: fromY), to: CGPoint(x: endX, y: endY))
        case .openApp:
            guard let appName = action.appName else { throw ExecutorError.appNotFound("(no name)") }
            try await openApp(name: appName)
        case .runAppleScript:
            guard let source = action.script else { throw ExecutorError.appleScriptMissingScript }
            // A script that drives System Events posts real input the helper
            // never sees, which would read as the person using the machine and
            // refuse the next step. Its run becomes a synthetic span.
            guard AppleScriptInputTakeover.takesOver(script: source) else {
                return try await runAppleScript(source)
            }
            let start = Date()
            defer {
                Self.syntheticSpanStart.withLock { $0 = start }
                Self.lastSyntheticPostAt.withLock { $0 = Date() }
            }
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

        // 5-second timeout — terminate the subprocess if it takes too long
        let timeoutTask = Task {
            try await Task.sleep(nanoseconds: 5_000_000_000)
            if process.isRunning {
                process.terminate()
            }
        }

        return try await withCheckedThrowingContinuation { continuation in
            // Assign the handler before launching: a fast script (e.g.
            // `return "ok"`) can exit before run() returns, and a handler set
            // afterward would miss the termination, leaving the continuation
            // suspended until the helper/proxy timeout.
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
            do {
                try process.run()
            } catch {
                timeoutTask.cancel()
                continuation.resume(throwing: error)
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
        postSynthetic(mouseDown)
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
            postSynthetic(dragEvent)
            usleep(10_000)
        }

        Self.notePointerPlaced(at: endPoint)
        guard let mouseUp = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseUp, mouseCursorPosition: endPoint, mouseButton: .left) else {
            throw ExecutorError.eventCreationFailed
        }
        postSynthetic(mouseUp)
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

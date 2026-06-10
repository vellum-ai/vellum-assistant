import CoreGraphics
import Foundation
import MacHelperCore

enum PttModifier: String, Hashable {
    case function
    case control
    case shift
    case option
    case command
    case rightCommand
    case rightOption
}

enum PttConfig: Equatable {
    case none
    case modifierOnly(Set<PttModifier>)
    case key(keyCode: Int64)
    case modifierKey(modifiers: Set<PttModifier>, keyCode: Int64)
    case mouseButton(button: Int64)

    var isEnabled: Bool {
        if case .none = self {
            return false
        }
        return true
    }
}

final class PttMonitor {
    private static let holdDelaySeconds: TimeInterval = 0.3

    private let emitState: (String) -> Void
    private var config: PttConfig = .none
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var pressedModifiers = Set<PttModifier>()
    private var isDown = false
    private var pendingModifierTimer: Timer?

    init(emitState: @escaping (String) -> Void) {
        self.emitState = emitState
    }

    func setConfig(_ nextConfig: PttConfig) throws -> Bool {
        cancelPendingModifierActivation()
        if isDown {
            emitUp()
        }

        config = nextConfig
        guard nextConfig.isEnabled else {
            stop()
            return false
        }

        try start()
        return true
    }

    func stop() {
        cancelPendingModifierActivation()
        if isDown {
            emitUp()
        }
        if let source = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
            runLoopSource = nil
        }
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
            eventTap = nil
        }
        pressedModifiers.removeAll()
    }

    fileprivate func handle(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let eventTap {
                CGEvent.tapEnable(tap: eventTap, enable: true)
            }
            return
        }

        switch type {
        case .flagsChanged:
            handleFlagsChanged(event)
        case .keyDown:
            handleKeyDown(event)
        case .keyUp:
            handleKeyUp(event)
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            handleMouseDown(type: type, event: event)
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            handleMouseUp(type: type, event: event)
        default:
            return
        }
    }

    private func start() throws {
        if eventTap != nil {
            return
        }

        let mask = Self.eventMask([
            .flagsChanged,
            .keyDown,
            .keyUp,
            .leftMouseDown,
            .leftMouseUp,
            .rightMouseDown,
            .rightMouseUp,
            .otherMouseDown,
            .otherMouseUp,
        ])
        let userInfo = Unmanaged.passUnretained(self).toOpaque()
        guard
            let tap = CGEvent.tapCreate(
                tap: .cgSessionEventTap,
                place: .headInsertEventTap,
                options: .listenOnly,
                eventsOfInterest: mask,
                callback: pttEventTapCallback,
                userInfo: userInfo
            )
        else {
            throw PttMonitorError.eventTapUnavailable
        }
        guard
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        else {
            CFMachPortInvalidate(tap)
            throw PttMonitorError.runLoopSourceUnavailable
        }

        eventTap = tap
        runLoopSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    private func handleFlagsChanged(_ event: CGEvent) {
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        if let modifier = modifierForKeyCode(keyCode) {
            if modifierIsDown(modifier, flags: event.flags) {
                pressedModifiers.insert(modifier)
            } else {
                pressedModifiers.remove(modifier)
            }
        }

        switch config {
        case let .modifierOnly(required):
            if modifierRequirementIsSatisfied(required) {
                scheduleModifierActivation(required: required)
            } else {
                cancelPendingModifierActivation()
                if isDown {
                    emitUp()
                }
            }
        case .key:
            if isDown && !pressedModifiers.isEmpty {
                emitUp()
            }
        case let .modifierKey(required, _):
            if isDown && !modifierRequirementIsSatisfied(required) {
                emitUp()
            }
        default:
            break
        }
    }

    private func handleKeyDown(_ event: CGEvent) {
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        if modifierForKeyCode(keyCode) == nil {
            cancelPendingModifierActivation()
        }

        switch config {
        case let .key(requiredKeyCode):
            if keyCode == requiredKeyCode, pressedModifiers.isEmpty, !isDown {
                emitDown()
            }
        case let .modifierKey(required, requiredKeyCode):
            if keyCode == requiredKeyCode,
               modifierRequirementIsSatisfied(required),
               !isDown
            {
                emitDown()
            }
        default:
            break
        }
    }

    private func handleKeyUp(_ event: CGEvent) {
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        switch config {
        case let .key(requiredKeyCode):
            if keyCode == requiredKeyCode && isDown {
                emitUp()
            }
        case let .modifierKey(_, requiredKeyCode):
            if keyCode == requiredKeyCode && isDown {
                emitUp()
            }
        default:
            break
        }
    }

    private func handleMouseDown(type: CGEventType, event: CGEvent) {
        guard case let .mouseButton(button) = config else {
            return
        }
        if mouseButtonNumber(type: type, event: event) == button && !isDown {
            emitDown()
        }
    }

    private func handleMouseUp(type: CGEventType, event: CGEvent) {
        guard case let .mouseButton(button) = config else {
            return
        }
        if mouseButtonNumber(type: type, event: event) == button && isDown {
            emitUp()
        }
    }

    private func scheduleModifierActivation(required: Set<PttModifier>) {
        if isDown || pendingModifierTimer != nil {
            return
        }
        pendingModifierTimer = Timer.scheduledTimer(
            withTimeInterval: Self.holdDelaySeconds,
            repeats: false
        ) { [weak self] _ in
            guard let self else {
                return
            }
            self.pendingModifierTimer = nil
            if self.modifierRequirementIsSatisfied(required), !self.isDown {
                self.emitDown()
            }
        }
    }

    private func cancelPendingModifierActivation() {
        pendingModifierTimer?.invalidate()
        pendingModifierTimer = nil
    }

    private func emitDown() {
        guard !isDown else {
            return
        }
        isDown = true
        emitState("down")
    }

    private func emitUp() {
        guard isDown else {
            return
        }
        isDown = false
        emitState("up")
    }

    private func modifierForKeyCode(_ keyCode: Int64) -> PttModifier? {
        switch keyCode {
        case 54:
            return .rightCommand
        case 55:
            return .command
        case 56, 60:
            return .shift
        case 58:
            return .option
        case 59, 62:
            return .control
        case 61:
            return .rightOption
        case 63:
            return .function
        default:
            return nil
        }
    }

    private func modifierIsDown(_ modifier: PttModifier, flags: CGEventFlags) -> Bool {
        switch modifier {
        case .function:
            return flags.contains(.maskSecondaryFn)
        case .control:
            return flags.contains(.maskControl)
        case .shift:
            return flags.contains(.maskShift)
        case .option, .rightOption:
            return flags.contains(.maskAlternate)
        case .command, .rightCommand:
            return flags.contains(.maskCommand)
        }
    }

    private func modifierRequirementIsSatisfied(_ required: Set<PttModifier>) -> Bool {
        var pressed = pressedModifiers
        if required.contains(.option), !required.contains(.rightOption) {
            if pressed.remove(.rightOption) != nil {
                pressed.insert(.option)
            }
        }
        if required.contains(.command), !required.contains(.rightCommand) {
            if pressed.remove(.rightCommand) != nil {
                pressed.insert(.command)
            }
        }
        return pressed == required
    }

    private func mouseButtonNumber(type: CGEventType, event: CGEvent) -> Int64 {
        switch type {
        case .leftMouseDown, .leftMouseUp:
            return 0
        case .rightMouseDown, .rightMouseUp:
            return 1
        default:
            return event.getIntegerValueField(.mouseEventButtonNumber)
        }
    }

    private static func eventMask(_ types: [CGEventType]) -> CGEventMask {
        types.reduce(CGEventMask(0)) { mask, type in
            mask | (CGEventMask(1) << CGEventMask(type.rawValue))
        }
    }
}

private func pttEventTapCallback(
    proxy _: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else {
        return Unmanaged.passUnretained(event)
    }

    let monitor = Unmanaged<PttMonitor>.fromOpaque(userInfo).takeUnretainedValue()
    monitor.handle(type: type, event: event)
    return Unmanaged.passUnretained(event)
}

enum PttMonitorError: LocalizedError {
    case eventTapUnavailable
    case runLoopSourceUnavailable

    var errorDescription: String? {
        switch self {
        case .eventTapUnavailable:
            return "CGEvent tap is unavailable"
        case .runLoopSourceUnavailable:
            return "CGEvent tap run loop source is unavailable"
        }
    }
}

func parsePttConfig(_ params: Any?) throws -> PttConfig {
    guard
        let object = params as? [String: Any],
        let rawConfig = object["config"] as? [String: Any],
        let kind = rawConfig["kind"] as? String
    else {
        throw JsonRpcDispatchError.invalidParams("ptt.setConfig requires config")
    }

    switch kind {
    case "none":
        return .none
    case "modifierOnly":
        return .modifierOnly(try parseModifiers(rawConfig["modifiers"]))
    case "key":
        return .key(keyCode: try parseInt(rawConfig["keyCode"], name: "keyCode"))
    case "modifierKey":
        return .modifierKey(
            modifiers: try parseModifiers(rawConfig["modifiers"]),
            keyCode: try parseInt(rawConfig["keyCode"], name: "keyCode")
        )
    case "mouseButton":
        return .mouseButton(button: try parseInt(rawConfig["button"], name: "button"))
    default:
        throw JsonRpcDispatchError.invalidParams("Unknown PTT config kind")
    }
}

private func parseModifiers(_ value: Any?) throws -> Set<PttModifier> {
    guard let values = value as? [Any], !values.isEmpty else {
        throw JsonRpcDispatchError.invalidParams("PTT modifiers must be non-empty")
    }
    var modifiers = Set<PttModifier>()
    for value in values {
        guard
            let raw = value as? String,
            let modifier = PttModifier(rawValue: raw)
        else {
            throw JsonRpcDispatchError.invalidParams("Unknown PTT modifier")
        }
        modifiers.insert(modifier)
    }
    return modifiers
}

private func parseInt(_ value: Any?, name: String) throws -> Int64 {
    let parsed: Int64
    if value is Bool {
        throw JsonRpcDispatchError.invalidParams("PTT \(name) must be a number")
    } else if let number = value as? NSNumber {
        parsed = number.int64Value
    } else if let int = value as? Int {
        parsed = Int64(int)
    } else {
        throw JsonRpcDispatchError.invalidParams("PTT \(name) must be a number")
    }
    if parsed < 0 {
        throw JsonRpcDispatchError.invalidParams("PTT \(name) must be non-negative")
    }
    return parsed
}

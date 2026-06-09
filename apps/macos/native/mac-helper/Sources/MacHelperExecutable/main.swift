import AppKit
import Carbon
import Darwin
import Foundation
import MacHelperCore

private let hotkeySignature = OSType(0x564C_464E) // "VLFN"
private let fnHotkeyId = EventHotKeyID(signature: hotkeySignature, id: 1)

private func hotkeyEventHandler(
    _ nextHandler: EventHandlerCallRef?,
    _ event: EventRef?,
    _ userData: UnsafeMutableRawPointer?
) -> OSStatus {
    guard let event, let userData else {
        return OSStatus(eventNotHandledErr)
    }

    let helper = Unmanaged<MacHelper>.fromOpaque(userData).takeUnretainedValue()
    switch GetEventKind(event) {
    case UInt32(kEventRawKeyModifiersChanged):
        helper.handleRawKeyModifiersChanged(event)
    case UInt32(kEventHotKeyPressed):
        guard isFnHotkeyEvent(event) else {
            return OSStatus(eventNotHandledErr)
        }
        helper.emitHotkey(state: "down")
    case UInt32(kEventHotKeyReleased):
        guard isFnHotkeyEvent(event) else {
            return OSStatus(eventNotHandledErr)
        }
        helper.emitHotkey(state: "up")
    default:
        return CallNextEventHandler(nextHandler, event)
    }

    return noErr
}

private func isFnHotkeyEvent(_ event: EventRef) -> Bool {
    var hotkeyId = EventHotKeyID()
    let status = GetEventParameter(
        event,
        EventParamName(kEventParamDirectObject),
        EventParamType(typeEventHotKeyID),
        nil,
        MemoryLayout<EventHotKeyID>.size,
        nil,
        &hotkeyId
    )
    return status == noErr &&
        hotkeyId.signature == hotkeySignature &&
        hotkeyId.id == fnHotkeyId.id
}

final class MacHelper: @unchecked Sendable {
    private var hotkeyRef: EventHotKeyRef?
    private var handlerRefs: [EventHandlerRef] = []
    private var isFnDown = false
    private let outputLock = NSLock()

    private lazy var router: JsonRpcRouter = {
        let router = JsonRpcRouter()
        router.register("ping") { _ in
            "pong"
        }
        router.register("hotkey.fnPushToTalk") { [weak self] params in
            guard let self else {
                throw JsonRpcDispatchError.internalError("Helper is shutting down")
            }
            guard
                let object = params as? [String: Any],
                let enable = object["enable"] as? Bool
            else {
                throw JsonRpcDispatchError.invalidParams(
                    "hotkey.fnPushToTalk requires enable"
                )
            }
            return try self.setFnPushToTalk(enable: enable)
        }
        return router
    }()

    @MainActor
    func run() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.readCommands()
        }
        NSApplication.shared.setActivationPolicy(.prohibited)
        NSApplication.shared.run()
    }

    func emitHotkey(state: String) {
        if state == "down" {
            guard !isFnDown else { return }
            isFnDown = true
        } else if state == "up" {
            guard isFnDown else { return }
            isFnDown = false
        }

        writeNotification(
            method: "hotkey.event",
            params: [
                "kind": "fnPushToTalk",
                "state": state,
            ]
        )
    }

    func handleRawKeyModifiersChanged(_ event: EventRef) {
        var modifiers: UInt32 = 0
        let status = GetEventParameter(
            event,
            EventParamName(kEventParamKeyModifiers),
            EventParamType(typeUInt32),
            nil,
            MemoryLayout<UInt32>.size,
            nil,
            &modifiers
        )
        guard status == noErr else {
            log("GetEventParameter(kEventParamKeyModifiers) failed with status \(status)")
            return
        }

        emitHotkey(
            state: (modifiers & UInt32(kEventKeyModifierFnMask)) != 0 ? "down" : "up"
        )
    }

    private func readCommands() {
        while let line = readLine() {
            guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                continue
            }
            DispatchQueue.main.async { [weak self] in
                self?.handleCommand(line)
            }
        }

        DispatchQueue.main.async { [weak self] in
            self?.shutdown()
            exit(0)
        }
    }

    private func handleCommand(_ line: String) {
        writeLine(router.handle(line: line))
    }

    private func setFnPushToTalk(enable: Bool) throws -> [String: Any] {
        if enable {
            try registerFnHotkey()
            return ["enabled": true]
        } else {
            unregisterFnHotkey()
            return ["enabled": false]
        }
    }

    private func registerFnHotkey() throws {
        if !handlerRefs.isEmpty {
            return
        }

        do {
            try installEventHandlers()
        } catch {
            removeEventHandlers()
            throw error
        }

        var registeredHotkey: EventHotKeyRef?
        let status = RegisterEventHotKey(
            UInt32(kVK_Function),
            0,
            fnHotkeyId,
            GetApplicationEventTarget(),
            0,
            &registeredHotkey
        )
        if status == noErr {
            hotkeyRef = registeredHotkey
        } else {
            log("RegisterEventHotKey failed with status \(status); raw modifier monitor remains active")
        }
    }

    private func unregisterFnHotkey() {
        if isFnDown {
            emitHotkey(state: "up")
        }
        if let ref = hotkeyRef {
            UnregisterEventHotKey(ref)
            hotkeyRef = nil
        }
        removeEventHandlers()
    }

    private func installEventHandlers() throws {
        let rawModifierEvents = [
            EventTypeSpec(
                eventClass: OSType(kEventClassKeyboard),
                eventKind: UInt32(kEventRawKeyModifiersChanged)
            ),
        ]
        try installHandler(
            target: GetEventMonitorTarget(),
            eventTypes: rawModifierEvents,
            operation: "InstallEventHandler(GetEventMonitorTarget)"
        )

        let applicationEvents = [
            EventTypeSpec(
                eventClass: OSType(kEventClassKeyboard),
                eventKind: UInt32(kEventRawKeyModifiersChanged)
            ),
            EventTypeSpec(
                eventClass: OSType(kEventClassKeyboard),
                eventKind: UInt32(kEventHotKeyPressed)
            ),
            EventTypeSpec(
                eventClass: OSType(kEventClassKeyboard),
                eventKind: UInt32(kEventHotKeyReleased)
            ),
        ]
        try installHandler(
            target: GetApplicationEventTarget(),
            eventTypes: applicationEvents,
            operation: "InstallEventHandler(GetApplicationEventTarget)"
        )
    }

    private func installHandler(
        target: EventTargetRef?,
        eventTypes: [EventTypeSpec],
        operation: String
    ) throws {
        guard let target else {
            throw HelperError.carbon(operation, OSStatus(eventNotHandledErr))
        }

        var installedHandler: EventHandlerRef?
        let userData = Unmanaged.passUnretained(self).toOpaque()
        let status = eventTypes.withUnsafeBufferPointer { buffer in
            InstallEventHandler(
                target,
                hotkeyEventHandler,
                buffer.count,
                buffer.baseAddress,
                userData,
                &installedHandler
            )
        }
        guard status == noErr, let installedHandler else {
            throw HelperError.carbon(operation, status)
        }
        handlerRefs.append(installedHandler)
    }

    private func removeEventHandlers() {
        for ref in handlerRefs {
            RemoveEventHandler(ref)
        }
        handlerRefs.removeAll()
    }

    private func shutdown() {
        unregisterFnHotkey()
    }

    private func writeNotification(method: String, params: Any? = nil) {
        do {
            let object = JsonRpcCodec.notification(method: method, params: params)
            writeLine(try JsonRpcCodec.encodeLine(object))
        } catch {
            log("Failed to encode notification: \(error.localizedDescription)")
        }
    }

    private func writeLine(_ line: String) {
        outputLock.lock()
        defer { outputLock.unlock() }

        FileHandle.standardOutput.write(Data(line.utf8))
        FileHandle.standardOutput.write(Data([0x0A]))
    }

    private func log(_ message: String) {
        FileHandle.standardError.write(Data("[vellum-mac-helper] \(message)\n".utf8))
    }
}

private enum HelperError: LocalizedError {
    case carbon(String, OSStatus)

    var errorDescription: String? {
        switch self {
        case let .carbon(operation, status):
            return "\(operation) failed with status \(status)"
        }
    }
}

let helper = MacHelper()
MainActor.assumeIsolated {
    helper.run()
}

import AppKit
import Carbon
import Darwin
import Foundation

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

    let helper = Unmanaged<HotkeyHelper>.fromOpaque(userData).takeUnretainedValue()
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

final class HotkeyHelper {
    private var hotkeyRef: EventHotKeyRef?
    private var handlerRefs: [EventHandlerRef] = []
    private var isFnDown = false
    private let outputLock = NSLock()

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

        write([
            "event": "hotkey-event",
            "payload": [
                "kind": "fnPushToTalk",
                "state": state,
            ],
        ])
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
            handleCommand(line)
        }

        DispatchQueue.main.async { [weak self] in
            self?.shutdown()
            exit(0)
        }
    }

    private func handleCommand(_ line: String) {
        guard let data = line.data(using: .utf8) else {
            writeError(id: nil, message: "Command is not valid UTF-8")
            return
        }

        let raw: Any
        do {
            raw = try JSONSerialization.jsonObject(with: data)
        } catch {
            writeError(id: nil, message: "Command is not valid JSON")
            return
        }

        guard let object = raw as? [String: Any] else {
            writeError(id: nil, message: "Command must be a JSON object")
            return
        }

        let id = object["id"] as? Int
        guard let method = object["method"] as? String else {
            writeError(id: id, message: "Command is missing method")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            switch method {
            case "hotkey.fnPushToTalk":
                let params = object["params"] as? [String: Any]
                guard let enable = params?["enable"] as? Bool else {
                    self.writeError(
                        id: id,
                        message: "hotkey.fnPushToTalk requires enable"
                    )
                    return
                }
                self.setFnPushToTalk(enable: enable, id: id)

            default:
                self.writeError(id: id, message: "Unknown method \(method)")
            }
        }
    }

    private func setFnPushToTalk(enable: Bool, id: Int?) {
        if enable {
            do {
                try registerFnHotkey()
                writeResult(id: id, result: ["enabled": true])
            } catch {
                writeError(id: id, message: error.localizedDescription)
            }
        } else {
            unregisterFnHotkey()
            writeResult(id: id, result: ["enabled": false])
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

    private func writeResult(id: Int?, result: [String: Any]) {
        var object: [String: Any] = ["ok": true, "result": result]
        if let id {
            object["id"] = id
        }
        write(object)
    }

    private func writeError(id: Int?, message: String) {
        var object: [String: Any] = ["ok": false, "error": message]
        if let id {
            object["id"] = id
        }
        write(object)
    }

    private func write(_ object: [String: Any]) {
        outputLock.lock()
        defer { outputLock.unlock() }

        do {
            let data = try JSONSerialization.data(withJSONObject: object)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0A]))
        } catch {
            let fallback = #"{"ok":false,"error":"Failed to encode response"}"#
            FileHandle.standardOutput.write(Data(fallback.utf8))
            FileHandle.standardOutput.write(Data([0x0A]))
        }
    }

    private func log(_ message: String) {
        FileHandle.standardError.write(Data("[hotkey-helper] \(message)\n".utf8))
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

let helper = HotkeyHelper()
helper.run()

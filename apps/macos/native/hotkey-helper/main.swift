import AppKit
import ApplicationServices
import Darwin
import Foundation

final class HotkeyHelper {
    private var fnMonitor: Any?
    private var isFnDown = false
    private let outputLock = NSLock()

    func run() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.readCommands()
        }
        RunLoop.main.run()
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
                    self.writeError(id: id, message: "hotkey.fnPushToTalk requires enable")
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
                try registerFnMonitor()
                writeResult(id: id, result: ["enabled": true])
            } catch {
                writeError(id: id, message: error.localizedDescription)
            }
        } else {
            unregisterFnMonitor()
            writeResult(id: id, result: ["enabled": false])
        }
    }

    private func registerFnMonitor() throws {
        if fnMonitor != nil {
            return
        }

        guard accessibilityTrusted(prompt: true) else {
            throw HelperError.accessibilityRequired
        }

        guard let monitor = NSEvent.addGlobalMonitorForEvents(
            matching: .flagsChanged,
            handler: { [weak self] event in
                DispatchQueue.main.async {
                    self?.handleFlagsChanged(event)
                }
            }
        ) else {
            throw HelperError.monitor("NSEvent flagsChanged monitor could not be installed")
        }

        fnMonitor = monitor
        handleFnHeld(NSEvent.modifierFlags.contains(.function))
    }

    private func unregisterFnMonitor() {
        if isFnDown {
            emitHotkey(state: "up")
        }
        if let monitor = fnMonitor {
            NSEvent.removeMonitor(monitor)
            fnMonitor = nil
        }
    }

    private func handleFlagsChanged(_ event: NSEvent) {
        handleFnHeld(event.modifierFlags.contains(.function))
    }

    private func handleFnHeld(_ isHeld: Bool) {
        emitHotkey(state: isHeld ? "down" : "up")
    }

    private func accessibilityTrusted(prompt: Bool) -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    private func shutdown() {
        unregisterFnMonitor()
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
}

private enum HelperError: LocalizedError {
    case accessibilityRequired
    case monitor(String)

    var errorDescription: String? {
        switch self {
        case .accessibilityRequired:
            return "Accessibility permission is required for Fn push-to-talk"
        case let .monitor(message):
            return message
        }
    }
}

let helper = HotkeyHelper()
helper.run()

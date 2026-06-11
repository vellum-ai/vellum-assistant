import AppKit
import AVFoundation
import Carbon
import Darwin
import Foundation
import IOKit.hid
import MacHelperCore
import Speech

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
    /// Whether this process re-exec'd with TCC responsibility disclaimed —
    /// the precondition for safely prompting for privacy permissions.
    let isDisclaimed: Bool
    private var hotkeyRef: EventHotKeyRef?
    private var handlerRefs: [EventHandlerRef] = []
    private var isFnDown = false
    private let outputLock = NSLock()
    private var dictationSession: DictationPartialsSession?
    // Bumped on every dictation.setPartials so a pending speech-authorization
    // callback can tell the session it was starting has since been stopped.
    private var dictationGeneration = 0

    init(isDisclaimed: Bool) {
        self.isDisclaimed = isDisclaimed
    }

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
        router.register("permission.status") { [weak self] params in
            guard let self else {
                throw JsonRpcDispatchError.internalError("Helper is shutting down")
            }
            let kind = try self.parsePermissionKind(params)
            return ["status": self.permissionStatus(kind: kind)]
        }
        router.register("dictation.setPartials") { [weak self] params in
            guard let self else {
                throw JsonRpcDispatchError.internalError("Helper is shutting down")
            }
            guard
                let object = params as? [String: Any],
                let enable = object["enable"] as? Bool
            else {
                throw JsonRpcDispatchError.invalidParams(
                    "dictation.setPartials requires enable"
                )
            }
            return self.setDictationPartials(enable: enable)
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

    /// Start/stop local speech-recognition partials (`dictation.partial`
    /// notifications). The renderer enables this for the dictation overlay
    /// whenever daemon streaming STT is unreachable.
    private func setDictationPartials(enable: Bool) -> [String: Any] {
        dictationGeneration += 1
        dictationSession?.stop()
        dictationSession = nil

        guard enable else {
            return ["enabled": false]
        }

        let speechStatus = SFSpeechRecognizer.authorizationStatus()
        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)

        if speechStatus == .authorized, micStatus == .authorized {
            return startDictationSession()
        }
        if speechStatus == .denied || speechStatus == .restricted {
            return ["enabled": false, "reason": "speech-recognition-denied"]
        }
        if micStatus == .denied || micStatus == .restricted {
            return ["enabled": false, "reason": "microphone-denied"]
        }

        // A privacy request from a process whose TCC-responsible ancestor
        // lacks the usage strings is a SIGABRT, not a denial. Only prompt
        // when this process runs disclaimed (its own embedded Info.plist is
        // the one TCC consults); otherwise degrade to no partials.
        guard isDisclaimed else {
            return ["enabled": false, "reason": "permissions-not-promptable"]
        }

        // First use: prompt for whichever permissions are undetermined and
        // start late once granted — the renderer simply receives partials
        // from that point on.
        let generation = dictationGeneration
        requestSpeechIfNeeded { [weak self] speechGranted in
            guard speechGranted else { return }
            Self.requestMicIfNeeded { micGranted in
                guard micGranted else { return }
                DispatchQueue.main.async {
                    guard
                        let self,
                        generation == self.dictationGeneration
                    else { return }
                    _ = self.startDictationSession()
                }
            }
        }
        return ["enabled": true, "authorizing": true]
    }

    private func requestSpeechIfNeeded(
        _ completion: @escaping @Sendable (Bool) -> Void
    ) {
        if SFSpeechRecognizer.authorizationStatus() == .authorized {
            completion(true)
            return
        }
        SFSpeechRecognizer.requestAuthorization { status in
            completion(status == .authorized)
        }
    }

    private static func requestMicIfNeeded(
        _ completion: @escaping @Sendable (Bool) -> Void
    ) {
        if AVCaptureDevice.authorizationStatus(for: .audio) == .authorized {
            completion(true)
            return
        }
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            completion(granted)
        }
    }

    private func startDictationSession() -> [String: Any] {
        let session = DictationPartialsSession { [weak self] text in
            self?.writeNotification(
                method: "dictation.partial",
                params: ["text": text]
            )
        }
        do {
            try session.start()
            dictationSession = session
            return ["enabled": true]
        } catch {
            log("dictation partials failed to start: \(error.localizedDescription)")
            return ["enabled": false, "reason": error.localizedDescription]
        }
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

    private enum PermissionKind: String {
        case speechRecognition
        case inputMonitoring
    }

    private func parsePermissionKind(_ params: Any?) throws -> PermissionKind {
        guard
            let object = params as? [String: Any],
            let rawKind = object["kind"] as? String,
            let kind = PermissionKind(rawValue: rawKind)
        else {
            throw JsonRpcDispatchError.invalidParams(
                "permission status calls require kind"
            )
        }
        return kind
    }

    private func permissionStatus(kind: PermissionKind) -> String {
        switch kind {
        case .speechRecognition:
            return speechRecognitionStatus()
        case .inputMonitoring:
            return inputMonitoringStatus()
        }
    }

    func permissionStatus(rawKind: String) throws -> String {
        guard let kind = PermissionKind(rawValue: rawKind) else {
            throw JsonRpcDispatchError.invalidParams(
                "permission status calls require kind"
            )
        }
        return permissionStatus(kind: kind)
    }

    private func speechRecognitionStatus() -> String {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            return "granted"
        case .denied:
            return "denied"
        case .restricted:
            return "restricted"
        case .notDetermined:
            return "not-determined"
        @unknown default:
            return "unknown"
        }
    }

    private func inputMonitoringStatus() -> String {
        switch IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) {
        case kIOHIDAccessTypeGranted:
            return "granted"
        case kIOHIDAccessTypeDenied:
            return "denied"
        case kIOHIDAccessTypeUnknown:
            return "not-determined"
        default:
            return "unknown"
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
        dictationGeneration += 1
        dictationSession?.stop()
        dictationSession = nil
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

let disclaimed = ensureDisclaimedResponsibility()
let helper = MacHelper(isDisclaimed: disclaimed)

private func argumentValue(after flag: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: flag) else {
        return nil
    }
    let valueIndex = CommandLine.arguments.index(after: index)
    guard valueIndex < CommandLine.arguments.endIndex else {
        return nil
    }
    return CommandLine.arguments[valueIndex]
}

private func writePermissionStatusAndExit() {
    guard
        let kind = argumentValue(after: "--permission-status"),
        let outputPath = argumentValue(after: "--status-output")
    else {
        FileHandle.standardError.write(
            Data("[vellum-mac-helper] permission status requires kind and output path\n".utf8)
        )
        exit(2)
    }

    do {
        let status = try helper.permissionStatus(rawKind: kind)
        let data = try JSONSerialization.data(
            withJSONObject: ["status": status],
            options: []
        )
        try data.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
        exit(0)
    } catch {
        FileHandle.standardError.write(
            Data("[vellum-mac-helper] failed to write permission status: \(error.localizedDescription)\n".utf8)
        )
        exit(1)
    }
}

if CommandLine.arguments.contains("--request-speech-recognition") {
    MainActor.assumeIsolated {
        NSApplication.shared.setActivationPolicy(.prohibited)
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            SFSpeechRecognizer.requestAuthorization { _ in
                DispatchQueue.main.async {
                    NSApplication.shared.terminate(nil)
                }
            }
            NSApplication.shared.run()
        }
    }
} else if CommandLine.arguments.contains("--request-input-monitoring") {
    MainActor.assumeIsolated {
        NSApplication.shared.setActivationPolicy(.prohibited)
        if IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) != kIOHIDAccessTypeGranted {
            _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
        }
        NSApplication.shared.terminate(nil)
    }
} else if CommandLine.arguments.contains("--permission-status") {
    writePermissionStatusAndExit()
} else {
    MainActor.assumeIsolated {
        helper.run()
    }
}

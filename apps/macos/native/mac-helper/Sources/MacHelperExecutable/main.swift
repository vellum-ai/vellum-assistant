import AppKit
import AVFoundation
import Carbon
import Darwin
import Foundation
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
    // The renderer's recording device (Chromium track label) — the helper
    // taps this same device so the native recognizer hears what the
    // MediaRecorder hears, not whatever the system default happens to be.
    private var dictationDeviceName: String?
    // Non-nil → the renderer pushes its own PCM via dictation.appendAudio
    // and the helper opens no device at all (a second capture client on the
    // renderer's device reads silence or kills the renderer's stream).
    private var dictationPushRate: Double?
    // PCM that arrived while the session was still authorizing — flushed
    // into the session on start so the first words aren't eaten. Capped at
    // ~10s (100 × 100ms chunks).
    private var pendingPushAudio: [Data] = []
    // Whether the current dictation session has produced any partial or
    // error callback — read by the on-device watchdog on the main queue.
    private var dictationSawActivity = false

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
            return self.setDictationPartials(
                enable: enable,
                deviceName: object["deviceName"] as? String,
                pushAudio: object["pushAudio"] as? Bool ?? false,
                sampleRate: object["sampleRate"] as? Double ?? 16000
            )
        }
        router.register("dictation.appendAudio") { [weak self] params in
            guard let self else {
                throw JsonRpcDispatchError.internalError("Helper is shutting down")
            }
            guard
                let object = params as? [String: Any],
                let base64 = object["audio"] as? String,
                let data = Data(base64Encoded: base64)
            else {
                throw JsonRpcDispatchError.invalidParams(
                    "dictation.appendAudio requires base64 audio"
                )
            }
            if let session = self.dictationSession {
                session.append(pcm: data)
            } else if self.dictationPushRate != nil,
                      self.pendingPushAudio.count < 100 {
                self.pendingPushAudio.append(data)
            }
            return ["ok": true]
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
    private func setDictationPartials(
        enable: Bool,
        deviceName: String? = nil,
        pushAudio: Bool = false,
        sampleRate: Double = 16000
    ) -> [String: Any] {
        dictationGeneration += 1
        dictationSession?.stop()
        dictationSession = nil
        dictationDeviceName = deviceName
        dictationPushRate = pushAudio ? sampleRate : nil
        pendingPushAudio.removeAll()

        guard enable else {
            return ["enabled": false]
        }

        // Push mode receives PCM from the renderer — it opens no device, so
        // microphone permission is irrelevant; only speech recognition is.
        let needMic = !pushAudio
        let speechStatus = SFSpeechRecognizer.authorizationStatus()
        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)

        if speechStatus == .authorized, !needMic || micStatus == .authorized {
            return startDictationSession()
        }
        if speechStatus == .denied || speechStatus == .restricted {
            return ["enabled": false, "reason": "speech-recognition-denied"]
        }
        if needMic, micStatus == .denied || micStatus == .restricted {
            return ["enabled": false, "reason": "microphone-denied"]
        }

        // A privacy request from a process whose TCC-responsible ancestor
        // lacks the usage strings is a SIGABRT, not a denial. Only prompt
        // when this process runs disclaimed (its own embedded Info.plist is
        // the one TCC consults); otherwise degrade to no partials. Do NOT
        // try to skip the disclaim in dev and ride the Electron identity:
        // when the shell runs from a terminal, the responsible process is
        // the TERMINAL, not Electron — observed as an instant SIGABRT on
        // the first speech-authorization request.
        guard isDisclaimed else {
            return ["enabled": false, "reason": "permissions-not-promptable"]
        }

        // First use: prompt for whichever permissions are undetermined and
        // start late once granted — the renderer simply receives partials
        // from that point on.
        let generation = dictationGeneration
        requestSpeechIfNeeded { [weak self] speechGranted in
            guard speechGranted else {
                // A silent return here is a black hole the renderer can't
                // see — it was told `authorizing: true` and waits forever.
                self?.writeNotification(
                    method: "dictation.error",
                    params: [
                        "message": "speech recognition permission not granted",
                        "onDevice": true,
                        "willRetryServer": false,
                    ]
                )
                return
            }
            let startAuthorized: @Sendable () -> Void = {
                DispatchQueue.main.async {
                    guard
                        let self,
                        generation == self.dictationGeneration
                    else { return }
                    _ = self.startDictationSession()
                }
            }
            guard needMic else {
                startAuthorized()
                return
            }
            Self.requestMicIfNeeded { [weak self] micGranted in
                guard micGranted else {
                    self?.writeNotification(
                        method: "dictation.error",
                        params: [
                            "message": "microphone permission not granted",
                            "onDevice": true,
                            "willRetryServer": false,
                        ]
                    )
                    return
                }
                startAuthorized()
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

    private func startDictationSession(requireOnDevice: Bool = true) -> [String: Any] {
        let generation = dictationGeneration
        dictationSawActivity = false
        let session = DictationPartialsSession(
            requireOnDevice: requireOnDevice,
            inputDeviceName: dictationDeviceName,
            pushSampleRate: dictationPushRate,
            emit: { [weak self] text in
                DispatchQueue.main.async {
                    guard let self, generation == self.dictationGeneration else {
                        return
                    }
                    self.dictationSawActivity = true
                }
                self?.writeNotification(
                    method: "dictation.partial",
                    params: ["text": text]
                )
            },
            onError: { [weak self] error in
                // Recognition died mid-session — e.g. kLSRErrorDomain 201
                // ("Siri and Dictation are disabled") when the on-device pin
                // is set but macOS Dictation isn't enabled. This used to be
                // swallowed, leaving the session looking alive while emitting
                // nothing. Surface it, and retry once on the server path so
                // online sessions still get partials.
                DispatchQueue.main.async {
                    guard let self, generation == self.dictationGeneration else {
                        return
                    }
                    self.dictationSawActivity = true
                    self.writeNotification(
                        method: "dictation.error",
                        params: [
                            "message": error.localizedDescription,
                            "onDevice": requireOnDevice,
                            "willRetryServer": requireOnDevice,
                        ]
                    )
                    guard requireOnDevice else { return }
                    self.dictationSession?.stop()
                    self.dictationSession = nil
                    _ = self.startDictationSession(requireOnDevice: false)
                }
            }
        )
        do {
            try session.start()
            dictationSession = session
            if !pendingPushAudio.isEmpty {
                for chunk in pendingPushAudio {
                    session.append(pcm: chunk)
                }
                pendingPushAudio.removeAll()
            }
            if requireOnDevice {
                scheduleOnDeviceWatchdog(generation: generation)
            }
            return ["enabled": true, "tap": session.tappedDevice]
        } catch {
            log("dictation partials failed to start: \(error.localizedDescription)")
            return ["enabled": false, "reason": error.localizedDescription]
        }
    }

    /// A pinned on-device task with a half-installed dictation asset can
    /// hang without ever calling back — no partial, no error (observed when
    /// the Dictation toggle was flipped while offline, so the model never
    /// finished downloading). Error-driven retry can't catch that, so a
    /// pinned session that stays silent is restarted on the server path.
    private func scheduleOnDeviceWatchdog(generation: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard
                let self,
                generation == self.dictationGeneration,
                !self.dictationSawActivity,
                self.dictationSession != nil
            else { return }
            let heardAudio = self.dictationSession?.heardAudio == true
            let tap = self.dictationSession?.tappedDevice ?? "unknown"
            self.writeNotification(
                method: "dictation.error",
                params: [
                    "message":
                        "on-device recognition produced no output (heardAudio=\(heardAudio), tap=\(tap)); retrying on the server path",
                    "onDevice": true,
                    "willRetryServer": true,
                ]
            )
            self.dictationSession?.stop()
            self.dictationSession = nil
            _ = self.startDictationSession(requireOnDevice: false)
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
MainActor.assumeIsolated {
    helper.run()
}

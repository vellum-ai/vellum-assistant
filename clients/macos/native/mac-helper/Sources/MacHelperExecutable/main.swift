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
    // The session draining toward its final transcript after a graceful
    // disable. Held strongly so the next enable can cancel it; cleared by
    // its own onFinal.
    private var finishingSession: DictationPartialsSession?
    // One-shot whole-utterance recognition of the renderer's recorded
    // audio (`dictation.transcribe`) — the offline transcript authority.
    // Streaming partials race the pump warmup and recognition latency on
    // short dictations; recognizing the complete recording does not.
    private var transcribeSession: DictationPartialsSession?
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
        router.register("dictation.transcribe") { [weak self] params in
            guard let self else {
                throw JsonRpcDispatchError.internalError("Helper is shutting down")
            }
            guard
                let object = params as? [String: Any],
                let base64 = object["audio"] as? String,
                let data = Data(base64Encoded: base64)
            else {
                throw JsonRpcDispatchError.invalidParams(
                    "dictation.transcribe requires base64 audio"
                )
            }
            return self.transcribeOnce(
                pcm: data,
                sampleRate: object["sampleRate"] as? Double ?? 16000
            )
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
        // Computer-use and app-control dispatch are async + @MainActor, so they
        // can't go through the synchronous JsonRpcRouter. Peek at the method and
        // hand the raw line off to an async dispatcher (which re-parses inside
        // the Task so no non-Sendable JSON value crosses the isolation boundary).
        if let data = line.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let method = object["method"] as? String,
           method == "cu.perform" || method == "appControl.perform" {
            if method == "cu.perform" {
                dispatchCuPerform(line: line)
            } else {
                dispatchAppControlPerform(line: line)
            }
            return
        }
        writeLine(router.handle(line: line))
    }

    private func dispatchCuPerform(line: String) {
        Task { @MainActor in
            let object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
            let id = object?["id"] ?? NSNull()
            let params = object?["params"] as? [String: Any] ?? [:]
            guard
                let requestId = params["requestId"] as? String,
                let conversationId = params["conversationId"] as? String,
                let toolName = params["toolName"] as? String
            else {
                self.writeResponse(JsonRpcCodec.errorResponse(
                    id: id,
                    code: JsonRpcErrorCode.invalidParams,
                    message: "cu.perform requires requestId, conversationId, toolName"
                ))
                return
            }
            let input = params["input"] as? [String: Any] ?? [:]
            let stepNumber = (params["stepNumber"] as? NSNumber)?.intValue ?? 0
            let reasoning = params["reasoning"] as? String
            let payload = await HostCuActionRunner.perform(
                requestId: requestId,
                conversationId: conversationId,
                toolName: toolName,
                input: input,
                stepNumber: stepNumber,
                reasoning: reasoning
            )
            self.writeResponse(
                JsonRpcCodec.successResponse(id: id, result: payload.toDictionary())
            )
        }
    }

    private func dispatchAppControlPerform(line: String) {
        Task { @MainActor in
            let object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
            let id = object?["id"] ?? NSNull()
            let params = object?["params"] as? [String: Any] ?? [:]
            guard let requestId = params["requestId"] as? String else {
                self.writeResponse(JsonRpcCodec.errorResponse(
                    id: id,
                    code: JsonRpcErrorCode.invalidParams,
                    message: "appControl.perform requires requestId"
                ))
                return
            }
            // The daemon sends `{requestId, conversationId, toolName, input:{...}}`
            // where `input` already carries the `tool` discriminator. Decode from
            // that sub-dict, falling back to the top-level params (so a toolName
            // discriminator can still be derived).
            let toolDict = params["input"] as? [String: Any] ?? params
            do {
                let input = try HostAppControlInput.from(dictionary: toolDict)
                let payload = await AppControlExecutor.perform(
                    requestId: requestId,
                    input: input
                )
                self.writeResponse(
                    JsonRpcCodec.successResponse(id: id, result: payload.toDictionary())
                )
            } catch let error as JsonRpcDispatchError {
                let message: String
                if case let .invalidParams(reason) = error { message = reason }
                else if case let .internalError(reason) = error { message = reason }
                else { message = "Invalid params" }
                self.writeResponse(JsonRpcCodec.errorResponse(
                    id: id,
                    code: JsonRpcErrorCode.invalidParams,
                    message: message
                ))
            } catch {
                self.writeResponse(JsonRpcCodec.errorResponse(
                    id: id,
                    code: JsonRpcErrorCode.internalError,
                    message: error.localizedDescription
                ))
            }
        }
    }

    private func writeResponse(_ object: [String: Any]) {
        do {
            writeLine(try JsonRpcCodec.encodeLine(object))
        } catch {
            log("Failed to encode response: \(error.localizedDescription)")
        }
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
        guard enable else {
            // Graceful end: short dictations (1-2s taps) stop before the
            // recognizer's first partial, so cancelling here would discard
            // the whole utterance. finish() ends the audio and lets
            // recognition complete — `dictation.finalized` carries the full
            // transcript (the finishing session's notifications are
            // unconditional, so the generation bump below doesn't mute it).
            // The bump kills stragglers that would otherwise outlive the
            // session: the watchdog, and a pending authorization callback
            // that would start a zombie mic session after the recording
            // already ended.
            dictationGeneration += 1
            finishingSession?.stop()
            finishingSession = dictationSession
            finishingSession?.finish()
            dictationSession = nil
            dictationPushRate = nil
            pendingPushAudio.removeAll()
            return ["enabled": false]
        }

        dictationGeneration += 1
        finishingSession?.stop()
        finishingSession = nil
        dictationSession?.stop()
        dictationSession = nil
        dictationDeviceName = deviceName
        dictationPushRate = pushAudio ? sampleRate : nil
        pendingPushAudio.removeAll()

        // Headless test hook — skip authorization entirely.
        if DictationPartialsSession.fakeRecognition {
            return startDictationSession()
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

    /// Recognize a complete utterance in one shot: append the whole PCM
    /// buffer, end the audio, and emit the final transcript as a
    /// `dictation.transcribed` notification (empty text on failure).
    private func transcribeOnce(
        pcm data: Data, sampleRate: Double
    ) -> [String: Any] {
        guard
            DictationPartialsSession.fakeRecognition
                || SFSpeechRecognizer.authorizationStatus() == .authorized
        else {
            return ["ok": false, "reason": "speech-recognition-not-authorized"]
        }
        transcribeSession?.stop()
        transcribeSession = nil

        let emitTranscribed: @Sendable (String) -> Void = { [weak self] text in
            DispatchQueue.main.async {
                guard let self else { return }
                self.writeNotification(
                    method: "dictation.transcribed",
                    params: ["text": text]
                )
                self.transcribeSession = nil
            }
        }
        let session = DictationPartialsSession(
            requireOnDevice: true,
            inputDeviceName: nil,
            pushSampleRate: sampleRate,
            emit: { _ in },
            onError: { _ in
                // finish() runs immediately below, so recognition errors
                // normally resolve through the finishing path with the best
                // partial. This only catches a pre-finish failure.
                emitTranscribed("")
            },
            onFinal: { text in
                emitTranscribed(text)
            }
        )
        do {
            try session.start()
        } catch {
            return ["ok": false, "reason": error.localizedDescription]
        }
        transcribeSession = session
        session.append(pcm: data)
        session.finish()
        return ["ok": true]
    }

    private func startDictationSession(requireOnDevice: Bool = true) -> [String: Any] {
        let generation = dictationGeneration
        dictationSawActivity = false
        let emitPartial: @Sendable (String) -> Void = { [weak self] text in
            DispatchQueue.main.async {
                guard let self, generation == self.dictationGeneration else {
                    return
                }
                self.dictationSawActivity = true
                self.writeNotification(
                    method: "dictation.partial",
                    params: ["text": text]
                )
            }
        }
        // Recognition died mid-session — e.g. kLSRErrorDomain 201
        // ("Siri and Dictation are disabled") when the on-device pin
        // is set but macOS Dictation isn't enabled. This used to be
        // swallowed, leaving the session looking alive while emitting
        // nothing. Surface it, and retry once on the server path so
        // online sessions still get partials.
        let emitError: @Sendable (Error) -> Void = { [weak self] error in
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
        // Fires once per session, after finish() (or a recognizer
        // self-finalization). The recording is already over — route
        // the completed transcript to the renderer. A session
        // cancelled by stop() never reaches this.
        let emitFinalized: @Sendable (String) -> Void = { [weak self] text in
            DispatchQueue.main.async {
                guard let self else { return }
                self.writeNotification(
                    method: "dictation.finalized",
                    params: ["text": text]
                )
                self.finishingSession = nil
            }
        }
        let session = DictationPartialsSession(
            requireOnDevice: requireOnDevice,
            inputDeviceName: dictationDeviceName,
            pushSampleRate: dictationPushRate,
            emit: { text in emitPartial(text) },
            onError: { error in emitError(error) },
            onFinal: { text in emitFinalized(text) }
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
            // The watchdog's restart-on-server-path only makes sense for
            // the mic tap: in push mode it would abandon the PCM already
            // appended to the request (and offline the server path is
            // useless anyway) — short dictations finish via
            // `dictation.finalized`/`dictation.transcribe` instead.
            if requireOnDevice, dictationPushRate == nil {
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
        finishingSession?.stop()
        finishingSession = nil
        transcribeSession?.stop()
        transcribeSession = nil
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

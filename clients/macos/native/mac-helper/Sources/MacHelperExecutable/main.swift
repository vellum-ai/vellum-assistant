import AppKit
import AVFoundation
import Carbon
import Darwin
import Foundation
import IOKit.hid
import MacHelperCore
import Speech

/// The keyboard tap's callback. Listen-only, so the event is always handed
/// back untouched; what is read off it is the modifier flags and the fact of a
/// key going down. A tap the system has switched off for taking too long is
/// switched back on here, since a dead tap is a dead key with nothing to say
/// so.
private func keyboardTapCallback(
    _ proxy: CGEventTapProxy,
    _ type: CGEventType,
    _ event: CGEvent,
    _ userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else {
        return Unmanaged.passUnretained(event)
    }
    let helper = Unmanaged<MacHelper>.fromOpaque(userInfo).takeUnretainedValue()
    switch type {
    case .flagsChanged:
        helper.handleFlagsChanged(event.flags)
    case .keyDown:
        helper.handleRawKeyDown()
    case .leftMouseDown, .rightMouseDown, .otherMouseDown:
        helper.handleMouseDown()
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
        helper.reenableKeyboardTap()
    default:
        break
    }
    return Unmanaged.passUnretained(event)
}

final class MacHelper: @unchecked Sendable {
    /// Whether this process re-exec'd with TCC responsibility disclaimed —
    /// the precondition for safely prompting for privacy permissions.
    let isDisclaimed: Bool
    /// The keyboard tap the hold detector reads, and its run loop source.
    ///
    /// A `CGEventTap` at the HID point rather than a Carbon monitor-target
    /// handler, and head-inserted there: other dictation apps watch the same
    /// key with an active session-level tap that swallows it, and a monitor
    /// downstream of that never hears the press at all. The HID point is
    /// upstream of every session tap, so the key is seen before anyone can
    /// take it. Listen-only, since the helper only ever reads.
    private var keyboardTap: CFMachPort?
    private var keyboardTapSource: CFRunLoopSource?
    private var modifierHoldDetector = ModifierHoldDetector()
    /// One mask per modifier of the configured set, each of which must be
    /// present in the flags for the set to count as held. A modifier is a pair
    /// of masks on this keyboard (left and right Control are different bits),
    /// so "held" is per modifier rather than per bit.
    private var modifierHoldMasks: [UInt32] = []
    private var isModifierHoldDown = false
    /// Whether presses are reported as activity, and when the last was, so a
    /// burst of typing is one notification every so often rather than one per
    /// key.
    private var activityWatch = false
    private var lastActivityReport = Date.distantPast
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
        // The windows a watch session could be scoped to, for the companion's
        // Teach picker and for the frame it draws around the picked one.
        router.register("captureSources.list") { params in
            let includeOffscreen = ((params as? [String: Any])?["includeOffscreen"] as? Bool) ?? false
            return CaptureSources.list(includeOffscreen: includeOffscreen)
        }
        // captureSources.raise is not registered here: it talks to another
        // app over AX, so it is dispatched off the main queue in
        // `handleCommand` like cu.perform.
        router.register("hotkey.modifierHold") { [weak self] params in
            guard let self else {
                throw JsonRpcDispatchError.internalError("Helper is shutting down")
            }
            guard
                let object = params as? [String: Any],
                let enable = object["enable"] as? Bool
            else {
                throw JsonRpcDispatchError.invalidParams(
                    "hotkey.modifierHold requires enable"
                )
            }
            let modifiers = object["modifiers"] as? [String] ?? []
            return try self.setModifierHold(enable: enable, modifiers: modifiers)
        }
        // What is highlighted in the application in front, read when the app
        // asks rather than on every press: a hold that has outlasted the
        // chords passing through it is the one worth reading for.
        router.register("selection.read") { [weak self] _ in
            guard let self else {
                throw JsonRpcDispatchError.internalError("Helper is shutting down")
            }
            return self.readFrontSelection()
        }
        // Which of the given applications are running, by bundle identifier.
        // The voice key asks before it arms Fn: another app watching the same
        // key would fire beside it, and a press doing two things is worse
        // than a key that stays out of the way.
        router.register("apps.running") { params in
            guard
                let object = params as? [String: Any],
                let bundleIds = object["bundleIds"] as? [String]
            else {
                throw JsonRpcDispatchError.invalidParams(
                    "apps.running requires bundleIds"
                )
            }
            let wanted = Set(bundleIds)
            let running = NSWorkspace.shared.runningApplications
                .compactMap(\.bundleIdentifier)
                .filter { wanted.contains($0) }
            return ["running": Array(Set(running)).sorted()]
        }
        // Ask an application to quit, the way a Quit menu item does. For the
        // notice that offers to get a competing dictation app off the voice
        // key. Whether it went is the caller's to check.
        router.register("apps.quit") { params in
            guard
                let object = params as? [String: Any],
                let bundleId = object["bundleId"] as? String
            else {
                throw JsonRpcDispatchError.invalidParams(
                    "apps.quit requires bundleId"
                )
            }
            let apps = NSRunningApplication.runningApplications(
                withBundleIdentifier: bundleId
            )
            let asked = apps.map { $0.terminate() }.contains(true)
            return ["asked": asked]
        }
        router.register("apps.frontmost") { _ in
            let bundleId = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
            return ["bundleId": bundleId as Any? ?? NSNull()]
        }
        // Whether the user is typing or clicking anywhere, reported without
        // which keys or where, for an offer that stands only while its edit
        // is the last one.
        router.register("input.setActivityWatch") { [weak self] params in
            guard let self else {
                throw JsonRpcDispatchError.internalError("Helper is shutting down")
            }
            guard
                let object = params as? [String: Any],
                let enable = object["enable"] as? Bool
            else {
                throw JsonRpcDispatchError.invalidParams(
                    "input.setActivityWatch requires enable"
                )
            }
            return try self.setActivityWatch(enable: enable)
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

    func emitModifierHold(edge: ModifierHoldDetector.Edge) {
        var params: [String: Any] = ["kind": "modifierHold"]
        switch edge {
        case .down:
            guard !isModifierHoldDown else { return }
            isModifierHoldDown = true
            params["state"] = "down"
        case .up(let reason):
            guard isModifierHoldDown else { return }
            isModifierHoldDown = false
            params["state"] = "up"
            params["reason"] = reason.rawValue
        }

        writeNotification(method: "hotkey.event", params: params)
    }

    /// What the user has highlighted in the application in front, for the
    /// hold that asks. Nothing once the hold has closed: a read that lands
    /// after the keys are up would sample whatever the user moved on to, and
    /// a hold over that is not the hold that was made. Character counts only
    /// in the log; the text itself is the user's.
    private func readFrontSelection() -> [String: Any] {
        guard isModifierHoldDown else {
            log("front selection: skipped, no hold is open")
            return [:]
        }
        let readStarted = Date()
        let outcome = FrontSelection.read()
        let readMs = Int(Date().timeIntervalSince(readStarted) * 1000)
        log("front selection: \(outcome.logLine) truncated=\(outcome.selection?.truncated ?? false) readMs=\(readMs)")
        guard let selection = outcome.selection else {
            return [:]
        }
        return [
            "selection": [
                "text": selection.text,
                "truncated": selection.truncated,
                "editable": selection.editable,
            ],
        ]
    }

    /// Every modifier this keyboard reports, so anything outside the configured
    /// set reads as a chord. Latched state (Caps Lock, Num Lock) is absent on
    /// purpose: it stays set for whole sessions and would disqualify every hold.
    private static let everyModifierMask: UInt32 =
        UInt32(cmdKey | shiftKey | optionKey | controlKey)
        | UInt32(kEventKeyModifierFnMask)

    /// The mask a modifier name is held by. The tap reports a modifier as one
    /// bit whichever hand pressed it, so there is one mask per name.
    private static func masks(forModifier name: String) -> UInt32? {
        switch name {
        case "command": return UInt32(cmdKey)
        case "shift": return UInt32(shiftKey)
        case "option": return UInt32(optionKey)
        case "control": return UInt32(controlKey)
        case "function": return UInt32(kEventKeyModifierFnMask)
        default: return nil
        }
    }

    /// The tap's flags as the Carbon masks the detector's tables are written
    /// in. Held modifiers only: latched state (Caps Lock) stays set across
    /// whole sessions and must not read as a chord.
    private static func carbonModifiers(_ flags: CGEventFlags) -> UInt32 {
        var modifiers: UInt32 = 0
        if flags.contains(.maskCommand) { modifiers |= UInt32(cmdKey) }
        if flags.contains(.maskShift) { modifiers |= UInt32(shiftKey) }
        if flags.contains(.maskAlternate) { modifiers |= UInt32(optionKey) }
        if flags.contains(.maskControl) { modifiers |= UInt32(controlKey) }
        if flags.contains(.maskSecondaryFn) { modifiers |= UInt32(kEventKeyModifierFnMask) }
        return modifiers
    }

    private func feedModifierHold(modifiers: UInt32) {
        guard !modifierHoldMasks.isEmpty else { return }

        let targetUnion = modifierHoldMasks.reduce(UInt32(0)) { $0 | $1 }
        let edges = modifierHoldDetector.flagsChanged(
            targetHeld: modifierHoldMasks.allSatisfy { (modifiers & $0) != 0 },
            anyTargetHeld: (modifiers & targetUnion) != 0,
            extraModifiersHeld: (modifiers & Self.everyModifierMask & ~targetUnion) != 0,
            ordinaryKeyHeld: { self.anyOrdinaryKeyIsDown() }
        )
        for edge in edges {
            emitModifierHold(edge: edge)
        }
    }

    func handleFlagsChanged(_ flags: CGEventFlags) {
        feedModifierHold(modifiers: Self.carbonModifiers(flags))
    }

    /// The system switches a tap off when its callback runs long or on the
    /// user's say-so; a tap left off is a key that has silently died.
    func reenableKeyboardTap() {
        guard let keyboardTap else { return }
        log("keyboard tap was disabled; enabling it again")
        CGEvent.tapEnable(tap: keyboardTap, enable: true)
    }

    /// Whether any non-modifier key is down right now, per the session's
    /// aggregate keyboard state. Polled only when a hold would open, to
    /// catch a chord whose ordinary key was pressed first (Delete held,
    /// then the set): the key-down handler only sees presses that happen
    /// while the set is already held. A poll of current state rather than
    /// tracked down/up events, so a missed event can never wedge the
    /// detector with a phantom held key.
    private func anyOrdinaryKeyIsDown() -> Bool {
        // Virtual keycodes 0x36...0x3F are the modifier block (Cmd, Shift,
        // Caps Lock, Option, Control, Fn, and right-hand variants); held
        // modifiers are already visible in the event flags.
        for keycode in 0..<128 where !(0x36...0x3F).contains(keycode) {
            if CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(keycode)) {
                return true
            }
        }
        return false
    }

    /// A key went down somewhere while the tap is watching. Only its
    /// existence is consumed, never its identity: the one fact needed is
    /// that the current hold is a chord (Fn+Delete, Fn+arrow), not a hold.
    func handleRawKeyDown() {
        for edge in modifierHoldDetector.keyDown() {
            emitModifierHold(edge: edge)
        }
        reportInputActivity()
    }

    /// A mouse button went down somewhere. Only the fact is consumed, never
    /// the button or the point.
    func handleMouseDown() {
        reportInputActivity()
    }

    private func reportInputActivity() {
        guard activityWatch,
              Date().timeIntervalSince(lastActivityReport) > 0.25
        else {
            return
        }
        lastActivityReport = Date()
        writeNotification(method: "input.activity")
    }

    private func setActivityWatch(enable: Bool) throws -> [String: Any] {
        activityWatch = enable
        if enable {
            try ensureMonitorInstalled()
        } else {
            releaseMonitorIfUnused()
        }
        return ["enabled": enable]
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
        // can't go through the synchronous JsonRpcRouter; a raise waits on
        // another app and must not hold the main queue. Peek at the method and
        // hand the raw line off to an async dispatcher (which re-parses inside
        // the Task so no non-Sendable JSON value crosses the isolation boundary).
        if let data = line.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let method = object["method"] as? String {
            switch method {
            case "cu.perform":
                dispatchCuPerform(line: line)
                return
            case "capture.frame":
                dispatchCaptureFrame(line: line)
                return
            case "appControl.perform":
                dispatchAppControlPerform(line: line)
                return
            case "captureSources.raise":
                dispatchCaptureSourcesRaise(line: line)
                return
            default:
                break
            }
        }
        writeLine(router.handle(line: line))
    }

    /// The window a pick named, brought to the front before the session that
    /// reads it starts. Off the main queue: the raise asks the window's app
    /// over AX, and an app that has stopped answering costs seconds per call
    /// even with the timeout `CaptureSources.raise` sets, during which the
    /// hotkeys, dictation and any computer-use action in flight would
    /// otherwise stand still with it.
    private func dispatchCaptureSourcesRaise(line: String) {
        Task.detached { [weak self] in
            let object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
            let id = object?["id"] ?? NSNull()
            let params = object?["params"] as? [String: Any] ?? [:]
            // A CGWindowID is 32 bits; a number outside that range is not one,
            // and converting it unchecked would trap the helper.
            guard
                let number = params["windowId"] as? Int,
                let windowId = CGWindowID(exactly: number)
            else {
                self?.writeResponse(JsonRpcCodec.errorResponse(
                    id: id,
                    code: JsonRpcErrorCode.invalidParams,
                    message: "captureSources.raise requires windowId"
                ))
                return
            }
            self?.writeResponse(
                JsonRpcCodec.successResponse(id: id, result: CaptureSources.raise(windowId: windowId))
            )
        }
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

    /// One JPEG of a display or a window, for the app to show a running call
    /// what the user is sharing. The same capture the daemon's computer-use
    /// path takes, reached directly: the app holds the share, not the daemon.
    private func dispatchCaptureFrame(line: String) {
        Task { @MainActor in
            let object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
            let id = object?["id"] ?? NSNull()
            let params = object?["params"] as? [String: Any] ?? [:]
            let target: CaptureTarget
            if let windowId = (params["windowId"] as? NSNumber)?.uint32Value {
                target = .window(CGWindowID(windowId))
            } else if let displayId = (params["displayId"] as? NSNumber)?.uint32Value {
                target = .display(CGDirectDisplayID(displayId))
            } else {
                self.writeResponse(JsonRpcCodec.errorResponse(
                    id: id,
                    code: JsonRpcErrorCode.invalidParams,
                    message: "capture.frame requires displayId or windowId"
                ))
                return
            }
            let maxWidth = (params["maxWidth"] as? NSNumber)?.intValue ?? 1280
            let maxHeight = (params["maxHeight"] as? NSNumber)?.intValue ?? 720
            do {
                let result = try await ScreenCapture().captureScreenWithMetadata(
                    maxWidth: maxWidth,
                    maxHeight: maxHeight,
                    target: target
                )
                self.writeResponse(JsonRpcCodec.successResponse(id: id, result: [
                    "jpegBase64": result.jpegData.base64EncodedString(),
                    "width": result.metadata?.screenshotWidthPx ?? 0,
                    "height": result.metadata?.screenshotHeightPx ?? 0,
                ]))
            } catch {
                self.writeResponse(JsonRpcCodec.errorResponse(
                    id: id,
                    code: JsonRpcErrorCode.internalError,
                    message: error.localizedDescription
                ))
            }
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

    private func setModifierHold(
        enable: Bool,
        modifiers: [String]
    ) throws -> [String: Any] {
        guard enable else {
            cancelModifierHold()
            modifierHoldMasks = []
            releaseMonitorIfUnused()
            return ["enabled": false]
        }

        let masks = try modifiers.map { name -> UInt32 in
            guard let mask = Self.masks(forModifier: name) else {
                throw JsonRpcDispatchError.invalidParams(
                    "hotkey.modifierHold does not know the modifier \(name)"
                )
            }
            return mask
        }
        guard !masks.isEmpty else {
            throw JsonRpcDispatchError.invalidParams(
                "hotkey.modifierHold requires at least one modifier"
            )
        }

        cancelModifierHold()
        modifierHoldMasks = masks
        modifierHoldDetector = ModifierHoldDetector()
        do {
            try ensureMonitorInstalled()
        } catch {
            modifierHoldMasks = []
            releaseMonitorIfUnused()
            throw error
        }
        return ["enabled": true]
    }

    /// Close an open hold, so a binding that goes away does not stand a
    /// microphone open with nothing left to close it.
    private func cancelModifierHold() {
        for edge in modifierHoldDetector.cancel() {
            emitModifierHold(edge: edge)
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

    /// The keyboard tap the hold detector reads. Installed when a binding asks
    /// for it and removed once none is left.
    private func ensureMonitorInstalled() throws {
        guard keyboardTap == nil else {
            return
        }
        do {
            try installEventHandlers()
        } catch {
            removeEventHandlers()
            throw error
        }
    }

    private func releaseMonitorIfUnused() {
        guard modifierHoldMasks.isEmpty, !activityWatch else {
            return
        }
        removeEventHandlers()
    }

    private func installEventHandlers() throws {
        // Modifier changes carry the hold; key presses are observed only to
        // disqualify a chord (`handleRawKeyDown`), and their contents are
        // never read.
        // Mouse presses ride along only to report activity: a click moves the
        // cursor, and an offer to replace the last edit is void once it has
        // moved. Where the click landed is never read.
        let mask = (1 << CGEventType.flagsChanged.rawValue)
            | (1 << CGEventType.keyDown.rawValue)
            | (1 << CGEventType.leftMouseDown.rawValue)
            | (1 << CGEventType.rightMouseDown.rawValue)
            | (1 << CGEventType.otherMouseDown.rawValue)
        let userInfo = Unmanaged.passUnretained(self).toOpaque()
        // Creation fails without Input Monitoring, which is the one way the
        // grant shows itself here: the tap is silent rather than refused.
        guard let tap = CGEvent.tapCreate(
            tap: .cghidEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: CGEventMask(mask),
            callback: keyboardTapCallback,
            userInfo: userInfo
        ) else {
            throw HelperError.eventTap("CGEvent.tapCreate(HID, listenOnly)")
        }
        let source = CFMachPortCreateRunLoopSource(nil, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        keyboardTap = tap
        keyboardTapSource = source
    }

    private func removeEventHandlers() {
        if let keyboardTap {
            CGEvent.tapEnable(tap: keyboardTap, enable: false)
            CFMachPortInvalidate(keyboardTap)
        }
        if let keyboardTapSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), keyboardTapSource, .commonModes)
        }
        keyboardTap = nil
        keyboardTapSource = nil
    }

    private func shutdown() {
        dictationGeneration += 1
        finishingSession?.stop()
        finishingSession = nil
        transcribeSession?.stop()
        transcribeSession = nil
        dictationSession?.stop()
        dictationSession = nil
        // A hold open at shutdown gets its closing edge, and the monitor comes
        // down with the binding.
        cancelModifierHold()
        modifierHoldMasks = []
        activityWatch = false
        releaseMonitorIfUnused()
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
    case eventTap(String)

    var errorDescription: String? {
        switch self {
        case let .carbon(operation, status):
            return "\(operation) failed with status \(status)"
        case let .eventTap(operation):
            return "\(operation) failed; Input Monitoring may not be granted"
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

if CommandLine.arguments.contains("--front-selection") {
    // A probe for what the application in front exposes: run it with something
    // highlighted and it prints what a hold would carry, then exits.
    let outcome = FrontSelection.read()
    var payload: [String: Any] = [
        "trusted": outcome.trusted,
        "promptShown": outcome.promptShown,
        "app": outcome.bundleId ?? NSNull(),
        "focused": outcome.focused,
        "role": outcome.role ?? NSNull(),
        "path": outcome.path.rawValue,
        "chars": outcome.chars,
    ]
    payload["text"] = outcome.selection?.text ?? NSNull()
    payload["truncated"] = outcome.selection?.truncated ?? false
    payload["editable"] = outcome.selection?.editable ?? false
    let data = try! JSONSerialization.data(withJSONObject: payload, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
} else if CommandLine.arguments.contains("--request-speech-recognition") {
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

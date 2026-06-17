import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation
import Speech

enum DictationPartialsError: LocalizedError {
    case recognizerUnavailable
    case noInputDevice

    var errorDescription: String? {
        switch self {
        case .recognizerUnavailable:
            return "speech recognizer unavailable"
        case .noInputDevice:
            return "no audio input device"
        }
    }
}

/// Streams local `SFSpeechRecognizer` partial transcriptions while dictation
/// records — the same role the recognizer played in the legacy Swift client.
///
/// This is the universal live-transcript source for the dictation overlay:
/// it needs no network topology at all, so it works for platform-managed
/// assistants whose runtime traffic rides the platform proxy (where the
/// renderer has no gateway WebSocket to stream against). When daemon
/// streaming STT *is* reachable, the renderer prefers those partials and
/// never starts this session.
///
/// Capture runs in the helper process: a tap on `AVAudioEngine`'s input node
/// feeds an `SFSpeechAudioBufferRecognitionRequest`, and every recognition
/// callback emits the cumulative best transcription via `emit`. The mic can
/// be captured here concurrently with the renderer's `MediaRecorder` — macOS
/// allows multiple taps on the default input.
final class DictationPartialsSession: @unchecked Sendable {
    private let audioEngine = AVAudioEngine()
    private let request = SFSpeechAudioBufferRecognitionRequest()
    private var task: SFSpeechRecognitionTask?
    private var stopped = false
    private let requireOnDevice: Bool
    private let inputDeviceName: String?
    // Non-nil → push mode: the renderer streams Int16 mono PCM at this rate
    // via `append(pcm:)` and the helper opens NO audio device. Required when
    // the renderer records the same mic: a second capture client on one
    // device either reads silence or kills the first client's stream
    // (observed both ways on Studio Display Microphone).
    private let pushSampleRate: Double?
    private var pushFormat: AVAudioFormat?
    private let emit: (String) -> Void
    private let onError: (Error) -> Void
    private let onFinal: (String) -> Void

    // Graceful-finish state. Short dictations (1-2s taps) end before the
    // recognizer's first partial, so cancelling the task at stop throws the
    // whole transcript away. finish() ends the audio and lets recognition
    // run to its final result instead. Mutations are serialized on the main
    // queue.
    private var finishing = false
    private var didFinal = false
    private var latestText = ""

    // See the test-hook comment in start(). Read by MacHelper's
    // authorization gates too — the scripted recognizer touches no
    // privacy API, so they are skipped wholesale.
    static let fakeRecognition =
        ProcessInfo.processInfo.environment["VELLUM_HELPER_FAKE_RECOGNITION"] == "1"
    private var fakeAppendedFrames: AVAudioFrameCount = 0

    /// Whether any captured buffer carried non-silence. Distinguishes "the
    /// recognizer produced nothing" from "the mic delivered nothing": a
    /// dormant or lid-closed device surfaces as silent buffers, not an
    /// error. Benign cross-thread bool — diagnostics only.
    private(set) var heardAudio = false

    /// Which device the tap actually captures, for diagnostics.
    private(set) var tappedDevice = "system default"

    init(
        requireOnDevice: Bool,
        inputDeviceName: String?,
        pushSampleRate: Double? = nil,
        emit: @escaping (String) -> Void,
        onError: @escaping (Error) -> Void,
        onFinal: @escaping (String) -> Void
    ) {
        self.requireOnDevice = requireOnDevice
        self.inputDeviceName = inputDeviceName
        self.pushSampleRate = pushSampleRate
        self.emit = emit
        self.onError = onError
        self.onFinal = onFinal
    }

    func start() throws {
        if let rate = pushSampleRate {
            guard
                let format = AVAudioFormat(
                    commonFormat: .pcmFormatInt16,
                    sampleRate: rate,
                    channels: 1,
                    interleaved: true
                )
            else {
                throw DictationPartialsError.noInputDevice
            }
            pushFormat = format
            tappedDevice = "renderer stream (pushed PCM @\(Int(rate))Hz)"
        } else {
            let input = audioEngine.inputNode
            selectInputDevice(on: input)
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw DictationPartialsError.noInputDevice
            }

            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self, request] buffer, _ in
                request.append(buffer)
                if let self, !self.heardAudio, Self.hasSignal(buffer) {
                    self.heardAudio = true
                }
            }

            do {
                audioEngine.prepare()
                try audioEngine.start()
            } catch {
                input.removeTap(onBus: 0)
                throw error
            }
        }

        // Headless test hook: a scripted recognizer exercises the JSON-RPC
        // contract (partials → graceful finish → finalized) without speech
        // authorization, which terminal contexts cannot prompt for. Never
        // set by the app.
        if Self.fakeRecognition {
            return
        }

        guard
            let recognizer = SFSpeechRecognizer()
                ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
            recognizer.isAvailable
        else {
            throw DictationPartialsError.recognizerUnavailable
        }

        request.shouldReportPartialResults = true
        // Pin recognition on-device when the locale has a local model:
        // dictation audio shouldn't leave the machine, and it keeps the
        // transcript working offline. Locales without an on-device model
        // stay on Apple's server path — forcing the flag there would fail
        // recognition outright instead of degrading.
        //
        // `supportsOnDeviceRecognition` is a capability claim, not an
        // enablement check: with macOS Dictation switched off the pinned
        // task dies at runtime (kLSRErrorDomain 201 "Siri and Dictation
        // are disabled"). The owner watches `onError` for that and retries
        // once with `requireOnDevice: false` so the server path still
        // serves online sessions.
        if requireOnDevice, recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            // SFSpeechRecognitionResult is not Sendable — extract what we
            // need before hopping to the main queue.
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            DispatchQueue.main.async {
                self.handleRecognition(text: text, isFinal: isFinal, error: error)
            }
        }
    }

    private func handleRecognition(
        text: String?, isFinal: Bool, error: Error?
    ) {
        guard !stopped else { return }
        if let error {
            // While finishing, errors (including the cancellation that
            // follows endAudio on some paths) terminate recognition — the
            // best partial so far IS the final transcript. Mid-session
            // errors keep the owner's retry semantics.
            if finishing {
                completeFinish(with: latestText)
            } else {
                onError(error)
            }
            return
        }
        guard let text else { return }
        if !text.isEmpty {
            latestText = text
        }
        emit(text)
        if isFinal {
            completeFinish(with: latestText)
        }
    }

    /// End the audio and let recognition run to its final result —
    /// `onFinal` fires with the completed transcript (or the best partial
    /// if the recognizer errors/times out). Use for normal end-of-recording.
    func finish() {
        guard !stopped, !finishing else { return }
        finishing = true
        if pushSampleRate == nil {
            audioEngine.inputNode.removeTap(onBus: 0)
            audioEngine.stop()
        }
        request.endAudio()
        if Self.fakeRecognition {
            // Scripted recognizer "finalizes" shortly after the audio ends.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self else { return }
                self.completeFinish(
                    with: self.latestText.isEmpty ? "fake final" : self.latestText
                )
            }
            return
        }
        // A pinned on-device task normally finalizes well under a second
        // after endAudio; the timeout only catches a wedged task.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5.0) { [weak self] in
            guard let self else { return }
            self.completeFinish(with: self.latestText)
        }
    }

    private func completeFinish(with text: String) {
        guard !didFinal, !stopped else { return }
        didFinal = true
        onFinal(text)
        task?.cancel()
        task = nil
    }

    /// Immediate teardown with no final callback — for session replacement
    /// and shutdown.
    func stop() {
        guard !stopped else { return }
        stopped = true
        if pushSampleRate == nil, !finishing {
            audioEngine.inputNode.removeTap(onBus: 0)
            audioEngine.stop()
        }
        request.endAudio()
        task?.cancel()
        task = nil
    }

    /// Push-mode input: append a chunk of Int16 mono LE PCM at
    /// `pushSampleRate` from the renderer's capture pipeline.
    func append(pcm data: Data) {
        guard !stopped, !finishing, let format = pushFormat else { return }
        let frameCount = AVAudioFrameCount(data.count / 2)
        guard
            frameCount > 0,
            let buffer = AVAudioPCMBuffer(
                pcmFormat: format, frameCapacity: frameCount
            )
        else { return }
        buffer.frameLength = frameCount
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let src = raw.baseAddress,
                  let dst = buffer.int16ChannelData?[0]
            else { return }
            memcpy(dst, src, Int(frameCount) * 2)
        }
        if !heardAudio, Self.hasSignal(int16: buffer) {
            heardAudio = true
        }
        request.append(buffer)

        if Self.fakeRecognition {
            fakeAppendedFrames += frameCount
            // One scripted partial per ~half second of appended audio.
            let interval = AVAudioFrameCount((pushSampleRate ?? 16000) / 2)
            if fakeAppendedFrames >= interval {
                fakeAppendedFrames = 0
                DispatchQueue.main.async { [weak self] in
                    guard let self, !self.stopped, !self.didFinal else { return }
                    self.latestText += self.latestText.isEmpty ? "fake" : " fake"
                    self.emit(self.latestText)
                }
            }
        }
    }

    private static func hasSignal(_ buffer: AVAudioPCMBuffer) -> Bool {
        guard let data = buffer.floatChannelData, buffer.frameLength > 0 else {
            return false
        }
        let samples = data[0]
        let count = Int(buffer.frameLength)
        var index = 0
        while index < count {
            if abs(samples[index]) > 0.002 { return true }
            index += 16
        }
        return false
    }

    private static func hasSignal(int16 buffer: AVAudioPCMBuffer) -> Bool {
        guard let data = buffer.int16ChannelData, buffer.frameLength > 0 else {
            return false
        }
        let samples = data[0]
        let count = Int(buffer.frameLength)
        var index = 0
        while index < count {
            if abs(Int(samples[index])) > 66 { return true }
            index += 16
        }
        return false
    }

    /// Point the input AU at the device the renderer records from.
    /// `AVAudioEngine` taps the system-default input otherwise, which is not
    /// necessarily the mic the user picked in Settings → Voice — on a docked
    /// Mac the default is often the (lid-closed) MacBook mic while the user
    /// speaks into a display or USB mic, so the default tap hears silence.
    private func selectInputDevice(on input: AVAudioInputNode) {
        guard let requested = inputDeviceName, !requested.isEmpty else { return }
        guard let match = Self.findInputDevice(named: requested) else {
            tappedDevice = "system default (no input matching \"\(requested)\")"
            return
        }
        guard let audioUnit = input.audioUnit else {
            tappedDevice = "system default (input AU unavailable)"
            return
        }
        var deviceID = match.id
        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &deviceID,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )
        tappedDevice = status == noErr
            ? "\"\(match.name)\""
            : "system default (selecting \"\(match.name)\" failed: \(status))"
    }

    /// Chromium track labels usually equal the CoreAudio device name, but
    /// can carry decorations — match exact first, containment second.
    private static func findInputDevice(
        named requested: String
    ) -> (id: AudioDeviceID, name: String)? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size
        ) == noErr, size > 0 else { return nil }
        var ids = [AudioDeviceID](
            repeating: 0,
            count: Int(size) / MemoryLayout<AudioDeviceID>.size
        )
        guard AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids
        ) == noErr else { return nil }

        let wanted = requested.lowercased()
        var fallback: (id: AudioDeviceID, name: String)?
        for id in ids {
            guard hasInputStreams(id), let name = deviceName(id) else { continue }
            let lowered = name.lowercased()
            if lowered == wanted { return (id, name) }
            if fallback == nil,
               lowered.contains(wanted) || wanted.contains(lowered) {
                fallback = (id, name)
            }
        }
        return fallback
    }

    private static func hasInputStreams(_ id: AudioDeviceID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        return AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr
            && size > 0
    }

    private static func deviceName(_ id: AudioDeviceID) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var name: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = AudioObjectGetPropertyData(id, &address, 0, nil, &size, &name)
        guard status == noErr, let value = name?.takeRetainedValue() else {
            return nil
        }
        return value as String
    }
}

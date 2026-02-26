import AVFoundation
import Foundation
import Speech
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "LiveTranscriptionEngine")

/// Feeds system audio buffers to SFSpeechRecognizer for continuous
/// live transcription. Handles the ~60s recognition timeout with
/// rolling sessions (same pattern as SpeechWakeWordEngine).
///
/// Audio from ScreenCaptureKit arrives at 48kHz; SFSpeechRecognizer
/// expects 16kHz mono. This engine handles the resampling internally.
final class LiveTranscriptionEngine {

    /// Called with partial and final transcription text.
    /// `isFinal` is true when the recognition session produces a final result.
    var onTranscription: ((_ text: String, _ isFinal: Bool) -> Void)?

    private(set) var isRunning = false

    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var restartTimer: Timer?

    private var sessionGeneration = 0
    private var consecutiveFailures = 0
    private static let maxBackoffSeconds: TimeInterval = 30

    /// Serial queue protecting recognitionRequest, audioConverter, and isRunning
    /// against concurrent access from the ScreenCaptureKit output queue and control methods.
    private let engineQueue = DispatchQueue(label: "com.vellum.LiveTranscriptionEngine")

    /// Rolling session duration — restart before the ~60s timeout.
    private static let sessionDuration: TimeInterval = 55

    /// AVAudioConverter for resampling 48kHz -> 16kHz mono.
    private var audioConverter: AVAudioConverter?
    private let targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!

    // MARK: - Start / Stop

    /// Returns `true` if the engine started successfully, `false` otherwise.
    @discardableResult
    func start() -> Bool {
        guard !isRunning else { return true }

        let authStatus = SFSpeechRecognizer.authorizationStatus()
        switch authStatus {
        case .notDetermined:
            log.info("Speech recognition authorization not determined — requesting")
            SFSpeechRecognizer.requestAuthorization { [weak self] status in
                DispatchQueue.main.async {
                    if status == .authorized {
                        self?.start()
                    } else {
                        log.warning("Speech recognition authorization denied")
                    }
                }
            }
            return false
        case .denied, .restricted:
            log.warning("Speech recognition not authorized — live transcription disabled")
            return false
        case .authorized:
            break
        @unknown default:
            break
        }

        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        guard let recognizer, recognizer.isAvailable else {
            log.warning("SFSpeechRecognizer not available")
            return false
        }

        self.speechRecognizer = recognizer
        engineQueue.sync { isRunning = true }
        consecutiveFailures = 0

        startRecognitionSession()
        scheduleRestartTimer()

        log.info("LiveTranscriptionEngine started (onDevice: \(recognizer.supportsOnDeviceRecognition, privacy: .public))")
        return true
    }

    func stop() {
        guard isRunning else { return }
        engineQueue.sync { isRunning = false }

        restartTimer?.invalidate()
        restartTimer = nil

        tearDownSession()
        speechRecognizer = nil
        engineQueue.sync { audioConverter = nil }

        log.info("LiveTranscriptionEngine stopped")
    }

    // MARK: - Audio Input

    /// Feed a CMSampleBuffer from SystemAudioCapture into the recognizer.
    /// Handles resampling from 48kHz to 16kHz internally.
    func appendAudioBuffer(_ sampleBuffer: CMSampleBuffer) {
        engineQueue.sync {
            guard isRunning, let recognitionRequest else { return }

            guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
                  let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else {
                return
            }

            let sourceFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: asbd.pointee.mSampleRate,
                channels: AVAudioChannelCount(asbd.pointee.mChannelsPerFrame),
                interleaved: false
            )!

            guard let pcmBuffer = sampleBuffer.toPCMBuffer(format: sourceFormat) else { return }

            // If already at 16kHz mono, append directly
            if sourceFormat.sampleRate == 16000 && sourceFormat.channelCount == 1 {
                recognitionRequest.append(pcmBuffer)
                return
            }

            // Resample to 16kHz mono
            if audioConverter == nil || audioConverter?.inputFormat != sourceFormat {
                audioConverter = AVAudioConverter(from: sourceFormat, to: targetFormat)
            }

            guard let converter = audioConverter else { return }

            let ratio = targetFormat.sampleRate / sourceFormat.sampleRate
            let outputFrameCount = AVAudioFrameCount(Double(pcmBuffer.frameLength) * ratio)
            guard outputFrameCount > 0 else { return }

            guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outputFrameCount) else { return }

            var inputConsumed = false
            let status = converter.convert(to: outputBuffer, error: nil) { _, outStatus in
                if inputConsumed {
                    outStatus.pointee = .noDataNow
                    return nil
                }
                inputConsumed = true
                outStatus.pointee = .haveData
                return pcmBuffer
            }

            if status == .haveData || status == .inputRanDry {
                recognitionRequest.append(outputBuffer)
            }
        }
    }

    // MARK: - Recognition Session

    private func startRecognitionSession() {
        guard isRunning, let speechRecognizer, speechRecognizer.isAvailable else { return }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if speechRecognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        request.addsPunctuation = true
        engineQueue.sync { self.recognitionRequest = request }

        sessionGeneration += 1
        let currentGeneration = sessionGeneration
        let sessionStartTime = Date()

        recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }

            if let result {
                let text = result.bestTranscription.formattedString
                let isFinal = result.isFinal
                self.onTranscription?(text, isFinal)
            }

            if error != nil || (result?.isFinal == true) {
                let sessionDuration = Date().timeIntervalSince(sessionStartTime)

                if let error {
                    let nsError = error as NSError
                    // Code 216 = cancellation during intentional restart
                    if nsError.domain == "kAFAssistantErrorDomain" && nsError.code == 216 {
                        return
                    }
                    log.error("Recognition ended after \(String(format: "%.1f", sessionDuration), privacy: .public)s: \(nsError.localizedDescription, privacy: .public)")
                }

                DispatchQueue.main.async { [weak self] in
                    guard let self, self.isRunning else { return }
                    guard self.sessionGeneration == currentGeneration else { return }

                    if sessionDuration < 1.0 {
                        self.consecutiveFailures += 1
                        let backoff = min(
                            pow(2.0, Double(self.consecutiveFailures)),
                            Self.maxBackoffSeconds
                        )
                        log.warning("Session failed fast (\(self.consecutiveFailures, privacy: .public)x) — retry in \(String(format: "%.0f", backoff), privacy: .public)s")
                        DispatchQueue.main.asyncAfter(deadline: .now() + backoff) { [weak self] in
                            guard let self, self.isRunning else { return }
                            guard self.sessionGeneration == currentGeneration else { return }
                            self.restartSession()
                        }
                    } else {
                        self.consecutiveFailures = 0
                        self.restartSession()
                    }
                }
            }
        }

        log.debug("Recognition session started")
    }

    private func tearDownSession() {
        engineQueue.sync {
            recognitionRequest?.endAudio()
            recognitionRequest = nil
        }
        recognitionTask?.cancel()
        recognitionTask = nil
    }

    private func restartSession() {
        guard isRunning else { return }
        tearDownSession()
        startRecognitionSession()
    }

    private func scheduleRestartTimer() {
        restartTimer?.invalidate()
        restartTimer = Timer.scheduledTimer(withTimeInterval: Self.sessionDuration, repeats: true) { [weak self] _ in
            guard let self, self.isRunning else { return }
            self.consecutiveFailures = 0
            self.restartSession()
        }
    }
}

// MARK: - CMSampleBuffer → AVAudioPCMBuffer

private extension CMSampleBuffer {
    /// Convert a CMSampleBuffer containing audio to an AVAudioPCMBuffer.
    func toPCMBuffer(format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let frameCount = CMSampleBufferGetNumSamples(self)
        guard frameCount > 0 else { return nil }

        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frameCount)) else {
            return nil
        }
        pcmBuffer.frameLength = AVAudioFrameCount(frameCount)

        guard let blockBuffer = CMSampleBufferGetDataBuffer(self) else { return nil }

        var lengthAtOffset: Int = 0
        var totalLength: Int = 0
        var dataPointer: UnsafeMutablePointer<Int8>?

        let status = CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: &lengthAtOffset, totalLengthOut: &totalLength, dataPointerOut: &dataPointer)
        guard status == kCMBlockBufferNoErr, let dataPointer else { return nil }

        // Copy audio data into the PCM buffer's float channel data
        if let floatData = pcmBuffer.floatChannelData {
            let bytesPerFrame = Int(format.streamDescription.pointee.mBytesPerFrame)
            let channelCount = Int(format.channelCount)

            if format.commonFormat == .pcmFormatFloat32 && !format.isInterleaved {
                // Non-interleaved float32 — copy per channel
                let samplesPerChannel = frameCount
                let totalSamples = min(totalLength / MemoryLayout<Float>.size, samplesPerChannel * channelCount)
                let sourcePtr = UnsafeRawPointer(dataPointer).assumingMemoryBound(to: Float.self)

                if channelCount == 1 {
                    memcpy(floatData[0], sourcePtr, min(totalLength, samplesPerChannel * MemoryLayout<Float>.size))
                } else {
                    // Non-interleaved (planar) source — each channel is a contiguous block
                    for ch in 0..<channelCount {
                        for i in 0..<samplesPerChannel {
                            let srcIdx = ch * samplesPerChannel + i
                            if srcIdx < totalSamples {
                                floatData[ch][i] = sourcePtr[srcIdx]
                            }
                        }
                    }
                }
            } else {
                // Fallback: treat as raw bytes and copy into channel 0
                let bytesToCopy = min(totalLength, frameCount * bytesPerFrame)
                memcpy(floatData[0], dataPointer, bytesToCopy)
            }
        }

        return pcmBuffer
    }
}

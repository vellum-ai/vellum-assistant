#if canImport(UIKit)
import Foundation
import Speech
import AVFoundation

// MARK: - Authorization Status

/// Unified authorization status for speech recognition, abstracting the platform-specific
/// `SFSpeechRecognizerAuthorizationStatus` so consumers and tests don't depend on the Speech framework.
enum SpeechRecognizerAuthorizationStatus {
    case authorized
    case denied
    case restricted
    case notDetermined
}

// MARK: - Recognition Result

/// A simplified speech recognition result delivered by the adapter, decoupling callers
/// from `SFSpeechRecognitionResult`.
struct SpeechRecognitionResult {
    /// The best transcription string for the current recognition pass.
    let transcription: String
    /// True when the recognizer has finalized the result and no further updates will arrive.
    let isFinal: Bool
}

// MARK: - Protocol

/// Abstraction boundary for on-device speech recognition on iOS.
///
/// The protocol covers the three operational phases callers care about:
/// 1. **Authorization** -- request and query permission to use speech recognition.
/// 2. **Availability** -- check whether a recognizer is available for the current locale.
/// 3. **Task construction** -- start a recognition task that delivers results via a callback.
///
/// Injecting this protocol instead of calling `SFSpeechRecognizer` directly lets the
/// `InputBarView` voice-input path be tested without a live microphone or OS permission dialogs.
@MainActor
protocol SpeechRecognizerAdapter {
    /// Request speech recognition authorization from the user.
    /// Returns the resulting authorization status.
    func requestAuthorization() async -> SpeechRecognizerAuthorizationStatus

    /// Whether a speech recognizer is currently available for the device locale.
    var isAvailable: Bool { get }

    /// Start a recognition task that consumes audio buffers appended to the returned request.
    ///
    /// - Parameter resultHandler: Called on the main queue with each partial or final result,
    ///   or with an error if recognition fails. The handler receives `(result, error)`.
    /// - Returns: A tuple of the audio buffer request (callers append `AVAudioPCMBuffer` to it)
    ///   and a cancellation closure that tears down the recognition task.
    /// - Throws: If a recognizer cannot be constructed for the current locale.
    func startRecognitionTask(
        resultHandler: @escaping (SpeechRecognitionResult?, Error?) -> Void
    ) throws -> (request: SFSpeechAudioBufferRecognitionRequest, cancel: () -> Void)
}

// MARK: - Apple Implementation

/// Production implementation backed by `SFSpeechRecognizer`.
@MainActor
final class AppleSpeechRecognizerAdapter: SpeechRecognizerAdapter {

    func requestAuthorization() async -> SpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                let mapped: SpeechRecognizerAuthorizationStatus
                switch status {
                case .authorized:    mapped = .authorized
                case .denied:        mapped = .denied
                case .restricted:    mapped = .restricted
                case .notDetermined: mapped = .notDetermined
                @unknown default:    mapped = .denied
                }
                continuation.resume(returning: mapped)
            }
        }
    }

    var isAvailable: Bool {
        guard let recognizer = SFSpeechRecognizer() else { return false }
        return recognizer.isAvailable
    }

    func startRecognitionTask(
        resultHandler: @escaping (SpeechRecognitionResult?, Error?) -> Void
    ) throws -> (request: SFSpeechAudioBufferRecognitionRequest, cancel: () -> Void) {
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            throw SpeechRecognizerAdapterError.recognizerUnavailable
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true

        let task = recognizer.recognitionTask(with: request) { sfResult, error in
            DispatchQueue.main.async {
                let mapped: SpeechRecognitionResult? = sfResult.map {
                    SpeechRecognitionResult(
                        transcription: $0.bestTranscription.formattedString,
                        isFinal: $0.isFinal
                    )
                }
                resultHandler(mapped, error)
            }
        }

        let cancel: () -> Void = { task.cancel() }
        return (request: request, cancel: cancel)
    }
}

// MARK: - Errors

enum SpeechRecognizerAdapterError: LocalizedError {
    case recognizerUnavailable

    var errorDescription: String? {
        switch self {
        case .recognizerUnavailable:
            return "Speech recognizer is not available on this device."
        }
    }
}

#endif

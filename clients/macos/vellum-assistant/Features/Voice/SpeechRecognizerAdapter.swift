import Foundation
import Speech

/// Abstraction over `SFSpeechRecognizer` static APIs and instance creation.
///
/// The production implementation (`AppleSpeechRecognizerAdapter`) delegates to
/// the real Speech framework. Tests can substitute a mock to avoid hardware and
/// permission dependencies.
protocol SpeechRecognizerAdapter: AnyObject, Sendable {
    /// Returns the current authorization status for speech recognition.
    func authorizationStatus() -> SFSpeechRecognizerAuthorizationStatus

    /// Requests speech recognition authorization from the user.
    /// The completion handler is called on the main queue with the granted status.
    func requestAuthorization(completion: @escaping @Sendable (SFSpeechRecognizerAuthorizationStatus) -> Void)

    /// Creates a new `SFSpeechRecognizer` for the given locale, or returns nil
    /// if the locale is not supported.
    func makeRecognizer(locale: Locale) -> SFSpeechRecognizer?

    /// Whether a speech recognizer is currently available for the device locale.
    /// Used by `VoiceInputManager` to gate recording without holding a reference
    /// to the concrete `SFSpeechRecognizer` — enabling tests to control availability
    /// independently of the real Speech framework.
    var isRecognizerAvailable: Bool { get }
}

/// Default adapter backed by the real Apple Speech framework.
final class AppleSpeechRecognizerAdapter: SpeechRecognizerAdapter {
    func authorizationStatus() -> SFSpeechRecognizerAuthorizationStatus {
        SFSpeechRecognizer.authorizationStatus()
    }

    func requestAuthorization(completion: @escaping @Sendable (SFSpeechRecognizerAuthorizationStatus) -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                completion(status)
            }
        }
    }

    func makeRecognizer(locale: Locale) -> SFSpeechRecognizer? {
        SFSpeechRecognizer(locale: locale)
    }

    var isRecognizerAvailable: Bool {
        guard let recognizer = SFSpeechRecognizer() else { return false }
        return recognizer.isAvailable
    }
}

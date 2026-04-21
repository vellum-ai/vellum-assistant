import AVFoundation
import Foundation
import VellumAssistantShared

/// One-shot TTS playback for the Voice Settings "Test" button.
///
/// Calls the existing generic TTS synthesis endpoint with the saved
/// configuration and plays the returned audio through the default output
/// device.
@MainActor
@Observable
final class TTSTestPlayer: NSObject, AVAudioPlayerDelegate {
    var isLoading: Bool = false
    var isPlaying: Bool = false
    var error: String? = nil

    @ObservationIgnored private var audioPlayer: AVAudioPlayer?
    @ObservationIgnored private let ttsClient: any TTSClientProtocol

    init(ttsClient: any TTSClientProtocol = TTSClient()) {
        self.ttsClient = ttsClient
        super.init()
    }

    func playTest(text: String) async {
        // Stop any prior playback so rapid Test taps don't overlap.
        stop()
        isLoading = true
        error = nil

        let result = await ttsClient.synthesizeText(text, context: nil, conversationId: nil)

        switch result {
        case .success(let data):
            do {
                let player = try AVAudioPlayer(data: data)
                player.delegate = self
                audioPlayer = player
                player.play()
                isPlaying = true
            } catch {
                self.error = "Failed to play audio"
            }

        case .featureDisabled:
            error = "Text-to-speech is not enabled"

        case .notConfigured:
            error = "Text-to-speech is not configured"

        case .notFound:
            error = "TTS endpoint not found"

        case .error(_, let message):
            error = message
        }

        isLoading = false
    }

    func stop() {
        audioPlayer?.stop()
        audioPlayer = nil
        isPlaying = false
    }

    // MARK: - AVAudioPlayerDelegate

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            isPlaying = false
            audioPlayer = nil
        }
    }
}

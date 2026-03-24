import AVFoundation
import Foundation
import VellumAssistantShared

/// Manages TTS audio playback for a single message bubble.
///
/// Each ChatBubble owns its own instance so multiple messages can have
/// independent playback state.
@MainActor
final class MessageAudioPlayer: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published var isLoading: Bool = false
    @Published var isPlaying: Bool = false
    @Published var error: String? = nil
    @Published var isNotConfigured: Bool = false
    @Published var isFeatureDisabled: Bool = false

    private var audioPlayer: AVAudioPlayer?
    private let ttsClient: any TTSClientProtocol

    init(ttsClient: any TTSClientProtocol = TTSClient()) {
        self.ttsClient = ttsClient
        super.init()
    }

    func playMessage(messageId: String, conversationId: String?) async {
        isLoading = true
        error = nil
        isNotConfigured = false
        isFeatureDisabled = false

        let result = await ttsClient.synthesize(messageId: messageId, conversationId: conversationId)

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
            isFeatureDisabled = true
            error = "Text-to-speech is not enabled"

        case .notConfigured:
            isNotConfigured = true
            error = "Text-to-speech is not configured"

        case .notFound:
            error = "Message not found"

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

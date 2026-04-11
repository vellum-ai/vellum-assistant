#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// TTS provider options for the unified global provider selector.
/// The selected provider is used for all speech features — voice conversations
/// and read-aloud. Provider-specific configuration (API keys, voice IDs)
/// is managed through the assistant's settings tools.
enum TTSProvider: String, CaseIterable {
    case elevenlabs = "elevenlabs"
    case fishAudio = "fish-audio"

    var displayName: String {
        switch self {
        case .elevenlabs: return "ElevenLabs"
        case .fishAudio: return "Fish Audio"
        }
    }

    var footerText: String {
        switch self {
        case .elevenlabs:
            return "ElevenLabs provides high-quality voice synthesis. Requires an API key — configure via the assistant's voice settings on your Mac."
        case .fishAudio:
            return "Fish Audio provides natural-sounding voice synthesis with custom voice cloning. Requires an API key and voice reference ID — configure via the assistant's voice settings on your Mac."
        }
    }
}

/// Voice mode settings — listening timeout, TTS provider, and silence detection
/// threshold. These mirror the equivalent options available on macOS.
struct VoiceSettingsSection: View {
    /// Seconds of silence that trigger end-of-speech detection. iOS SFSpeechRecognizer
    /// does not have a built-in silence threshold API, so this value controls how long
    /// the InputBarView waits after the last speech activity before stopping the
    /// recognition task automatically. Range 0.5 – 3.0 s.
    @AppStorage(UserDefaultsKeys.voiceSilenceThreshold) private var silenceThreshold: Double = 1.0

    /// Maximum recording duration in seconds before the recogniser is stopped
    /// automatically (listening timeout). A value of 0 means no auto-stop.
    /// Range 5 – 60 s.
    @AppStorage(UserDefaultsKeys.voiceListeningTimeout) private var listeningTimeout: Double = 30.0

    /// Global TTS provider used for all speech features.
    @AppStorage(UserDefaultsKeys.voiceTTSProvider) private var ttsProviderRaw: String = TTSProvider.elevenlabs.rawValue

    private var ttsProvider: TTSProvider {
        TTSProvider(rawValue: ttsProviderRaw) ?? .elevenlabs
    }

    var body: some View {
        Form {
            // MARK: - Listening

            Section {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("Listening Timeout")
                        Spacer()
                        Text(listeningTimeout == 0 ? "Off" : "\(Int(listeningTimeout))s")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    Slider(value: $listeningTimeout, in: 5...60, step: 5)
                }
                .padding(.vertical, 4)
            } header: {
                Text("Listening")
            } footer: {
                Text("Maximum recording duration before the microphone stops automatically. Set to 5 s for short commands or up to 60 s for long dictation.")
            }

            // MARK: - Silence Detection

            Section {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("Silence Threshold")
                        Spacer()
                        Text(String(format: "%.1fs", silenceThreshold))
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    Slider(value: $silenceThreshold, in: 0.5...3.0, step: 0.5)
                }
                .padding(.vertical, 4)
            } header: {
                Text("Silence Detection")
            } footer: {
                Text("How long silence must last before speech is considered finished and the recording stops. Lower values respond faster; higher values give more time for pauses.")
            }

            // MARK: - TTS Provider

            Section {
                Picker("TTS Provider", selection: $ttsProviderRaw) {
                    ForEach(TTSProvider.allCases, id: \.rawValue) { provider in
                        Text(provider.displayName).tag(provider.rawValue)
                    }
                }
                .pickerStyle(.navigationLink)
            } header: {
                Text("Text-to-Speech")
            } footer: {
                Text(ttsProvider.footerText)
            }
        }
        .navigationTitle("Voice")
        .navigationBarTitleDisplayMode(.inline)
    }
}
#endif

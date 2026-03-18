#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// TTS provider options surfaced in Voice settings.
/// The system provider uses iOS AVSpeechSynthesizer; ElevenLabs uses the
/// ElevenLabs REST API (requires an API key stored in the keychain under "elevenlabs").
enum TTSProvider: String, CaseIterable {
    case system = "system"
    case elevenLabs = "elevenlabs"

    var displayName: String {
        switch self {
        case .system: return "System (Apple)"
        case .elevenLabs: return "ElevenLabs"
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

    /// TTS provider used when the assistant speaks a response.
    @AppStorage(UserDefaultsKeys.voiceTTSProvider) private var ttsProviderRaw: String = TTSProvider.system.rawValue

    private var ttsProvider: TTSProvider {
        TTSProvider(rawValue: ttsProviderRaw) ?? .system
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
                Group {
                    if ttsProvider == .elevenLabs {
                        Text("ElevenLabs requires an API key. Get yours at elevenlabs.io — this is the same provider used by voice mode on macOS.")
                    } else {
                        Text("System uses Apple's built-in AVSpeechSynthesizer. No API key required.")
                    }
                }
            }

            // ElevenLabs API key entry (shown only when ElevenLabs is selected)
            if ttsProvider == .elevenLabs {
                ElevenLabsKeySection()
            }
        }
        .navigationTitle("Voice")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - ElevenLabs Key Section

/// Inline key management for ElevenLabs — shown when ElevenLabs TTS is selected.
private struct ElevenLabsKeySection: View {
    @State private var keyText: String = ""
    @State private var isSaved = false
    @State private var hasExistingKey = false

    var body: some View {
        Section {
            if hasExistingKey {
                HStack {
                    VIconView(.circleCheck, size: 16)
                        .foregroundColor(.green)
                    Text("API key saved")
                    Spacer()
                    Button("Remove", role: .destructive) {
                        _ = APIKeyManager.shared.deleteAPIKey(provider: "elevenlabs")
                        hasExistingKey = false
                        keyText = ""
                    }
                    .font(.caption)
                }
            } else {
                SecureField("ElevenLabs API Key", text: $keyText)
                    .textContentType(.password)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)

                Button("Save") {
                    let trimmed = keyText.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { return }
                    _ = APIKeyManager.shared.setAPIKey(trimmed, provider: "elevenlabs")
                    hasExistingKey = true
                    keyText = ""
                }
                .disabled(keyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        } header: {
            Text("ElevenLabs API Key")
        } footer: {
            Text("Your key is stored securely in the iOS Keychain and never sent to Vellum servers.")
        }
        .onAppear {
            hasExistingKey = APIKeyManager.shared.getAPIKey(provider: "elevenlabs") != nil
        }
    }
}
#endif

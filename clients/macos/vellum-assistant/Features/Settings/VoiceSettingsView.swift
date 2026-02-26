import SwiftUI
import VellumAssistantShared

/// Voice settings tab — configure push-to-talk activation key,
/// enable/disable wake word listening, configure keyword phrase,
/// and conversation timeout.
struct VoiceSettingsView: View {
    @ObservedObject var store: SettingsStore

    @AppStorage("activationKey") private var activationKey: String = "fn"
    @AppStorage("wakeWordEnabled") private var wakeWordEnabled: Bool = false
    @AppStorage("wakeWordTimeoutSeconds") private var wakeWordTimeoutSeconds: Int = 30
    @AppStorage("wakeWordKeyword") private var wakeWordKeyword: String = "computer"

    @State private var elevenLabsKeyText: String = ""

    private let suggestedKeywords = ["computer", "jarvis", "hey vellum", "assistant"]

    private var selectedActivationKey: ActivationKey {
        ActivationKey(rawValue: activationKey) ?? .fn
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            // Push to Talk
            pttDivider
            pttStatusSection
            pttKeyPicker
            pttPrivacyNote

            // Wake Word
            wakeWordDivider
            statusSection
            educationHero
            howItWorksSteps
            tryItPrompt
            settingsDivider
            enableSection
            keywordSection
            timeoutSection
            privacyNote

            // Text-to-Speech
            ttsDivider
            ttsStatusSection
            ttsKeySection
            ttsPrivacyNote
        }
    }

    // MARK: - PTT Section Divider

    private var pttDivider: some View {
        HStack(spacing: VSpacing.md) {
            Text("PUSH TO TALK")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(VColor.textMuted)
                .tracking(1)

            Rectangle()
                .fill(VColor.surfaceBorder)
                .frame(height: 1)
        }
    }

    // MARK: - PTT Status

    private var pttStatusSection: some View {
        HStack(spacing: VSpacing.sm) {
            Circle()
                .fill(selectedActivationKey != .none ? VColor.success : VColor.textMuted)
                .frame(width: 8, height: 8)

            Text(selectedActivationKey != .none ? "Activation key: \(selectedActivationKey.displayName)" : "Push to talk disabled")
                .font(VFont.body)
                .foregroundColor(selectedActivationKey != .none ? VColor.success : VColor.textSecondary)

            Spacer()
        }
        .padding(VSpacing.lg)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(selectedActivationKey != .none ? VColor.success.opacity(0.08) : VColor.surfaceSubtle)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .strokeBorder(selectedActivationKey != .none ? VColor.success.opacity(0.2) : VColor.surfaceBorder, lineWidth: 1)
                )
        )
    }

    // MARK: - PTT Key Picker

    private var pttKeyPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Activation key")
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.textPrimary)

            HStack(spacing: VSpacing.sm) {
                ForEach(ActivationKey.allCases, id: \.rawValue) { key in
                    Button(key.displayName) {
                        activationKey = key.rawValue
                    }
                    .buttonStyle(.plain)
                    .font(VFont.caption)
                    .foregroundColor(selectedActivationKey == key ? .white : VColor.textMuted)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)
                    .background(
                        Capsule()
                            .fill(selectedActivationKey == key ? Forest._700 : VColor.surface)
                    )
                    .overlay(
                        Capsule()
                            .strokeBorder(selectedActivationKey == key ? Color.clear : VColor.surfaceBorder, lineWidth: 1)
                    )
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - PTT Privacy Note

    private var pttPrivacyNote: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            Image(systemName: "lock.fill")
                .font(.system(size: 10))
                .foregroundColor(VColor.textMuted)

            Text("Hold the activation key to dictate text or start a voice conversation. Uses on-device speech recognition.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .lineSpacing(2)
        }
    }

    // MARK: - Wake Word Section Divider

    private var wakeWordDivider: some View {
        HStack(spacing: VSpacing.md) {
            Text("WAKE WORD")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(VColor.textMuted)
                .tracking(1)

            Rectangle()
                .fill(VColor.surfaceBorder)
                .frame(height: 1)
        }
    }

    // MARK: - Status

    private var statusSection: some View {
        HStack(spacing: VSpacing.sm) {
            Circle()
                .fill(wakeWordEnabled ? VColor.success : VColor.textMuted)
                .frame(width: 8, height: 8)

            Text(wakeWordEnabled ? "Listening for \"\(wakeWordKeyword)\"" : "Wake word disabled")
                .font(VFont.body)
                .foregroundColor(wakeWordEnabled ? VColor.success : VColor.textSecondary)

            Spacer()
        }
        .padding(VSpacing.lg)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(wakeWordEnabled ? VColor.success.opacity(0.08) : VColor.surfaceSubtle)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .strokeBorder(wakeWordEnabled ? VColor.success.opacity(0.2) : VColor.surfaceBorder, lineWidth: 1)
                )
        )
    }

    // MARK: - Education Hero

    private var educationHero: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Talk to Vellum, hands-free")
                .font(VFont.cardTitle)
                .foregroundColor(VColor.textPrimary)

            Text("Wake word lets you start a conversation by speaking a keyword aloud \u{2014} no need to click or press anything. It uses on-device speech recognition, so nothing you say ever leaves your Mac.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .lineSpacing(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.xl)
        .background(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .fill(VColor.surfaceSubtle)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .strokeBorder(VColor.surfaceBorder, lineWidth: 1)
        )
    }

    // MARK: - How It Works

    private var howItWorksSteps: some View {
        HStack(alignment: .top, spacing: VSpacing.md) {
            stepCard(number: "1", title: "Say the keyword", description: "Speak your wake word when you're ready to talk.", showConnector: true)
            stepCard(number: "2", title: "Vellum starts listening", description: "A chime plays and your microphone activates.", showConnector: true)
            stepCard(number: "3", title: "Ask anything", description: "Speak naturally. Vellum responds when you pause.", showConnector: false)
        }
    }

    private func stepCard(number: String, title: String, description: String, showConnector: Bool) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text(number)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(VColor.success)
                .frame(width: 24, height: 24)
                .background(
                    Circle()
                        .fill(VColor.success.opacity(0.15))
                )

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(title)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)

                Text(description)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .lineSpacing(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Try It

    private var tryItPrompt: some View {
        HStack(spacing: VSpacing.md) {
            Image(systemName: "mic.fill")
                .font(.system(size: 14))
                .foregroundColor(VColor.textSecondary)

            HStack(spacing: VSpacing.xs) {
                Text("Try it now")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)

                Text("\u{2014} say")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)

                Text(wakeWordKeyword)
                    .font(VFont.bodyMedium)
                    .foregroundColor(.white)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xxs)
                    .background(
                        Capsule()
                            .fill(Forest._700)
                    )

                Text("followed by a question")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.success.opacity(0.08))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .strokeBorder(VColor.success.opacity(0.2), style: StrokeStyle(lineWidth: 1, dash: [6, 4]))
                )
        )
    }

    // MARK: - Section Divider

    private var settingsDivider: some View {
        HStack(spacing: VSpacing.md) {
            Text("SETTINGS")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(VColor.textMuted)
                .tracking(1)

            Rectangle()
                .fill(VColor.surfaceBorder)
                .frame(height: 1)
        }
    }

    // MARK: - Enable/Disable

    private var enableSection: some View {
        HStack {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Enable wake word listening")
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                Text("Activate the assistant by speaking instead of using a keyboard shortcut.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }
            Spacer()
            Toggle("", isOn: $wakeWordEnabled)
                .toggleStyle(.switch)
                .labelsHidden()
                .accessibilityLabel("Enable wake word listening")
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Keyword

    private var keywordSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Keyword")
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.textPrimary)

            TextField("Enter wake word or phrase", text: $wakeWordKeyword)
                .vInputStyle()
                .accessibilityLabel("Wake word keyword")

            HStack(spacing: VSpacing.sm) {
                ForEach(suggestedKeywords, id: \.self) { suggestion in
                    Button(suggestion) {
                        wakeWordKeyword = suggestion
                    }
                    .buttonStyle(.plain)
                    .font(VFont.caption)
                    .foregroundColor(wakeWordKeyword == suggestion ? .white : VColor.textMuted)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)
                    .background(
                        Capsule()
                            .fill(wakeWordKeyword == suggestion ? Forest._700 : VColor.surface)
                    )
                    .overlay(
                        Capsule()
                            .strokeBorder(wakeWordKeyword == suggestion ? Color.clear : VColor.surfaceBorder, lineWidth: 1)
                    )
                }
            }

            HStack(spacing: VSpacing.xs) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 10))
                    .foregroundColor(VColor.textMuted)
                Text("Type any word or phrase. Uses on-device speech recognition \u{2014} no data leaves your Mac.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Timeout

    private var timeoutSection: some View {
        HStack {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Conversation timeout")
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                Text("How long to wait for follow-up speech before ending the conversation.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }
            Spacer()
            Picker("", selection: $wakeWordTimeoutSeconds) {
                Text("5 seconds").tag(5)
                Text("10 seconds").tag(10)
                Text("15 seconds").tag(15)
                Text("30 seconds").tag(30)
                Text("60 seconds").tag(60)
            }
            .pickerStyle(.menu)
            .frame(width: 140)
            .accessibilityLabel("Conversation timeout duration")
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Privacy Note

    private var privacyNote: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            Image(systemName: "shield.fill")
                .font(.system(size: 12))
                .foregroundColor(VColor.textMuted)

            Text("Wake word detection runs entirely on your device using Apple's Speech framework. Audio is only processed when the wake word is detected, and no recordings are stored or sent anywhere.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .lineSpacing(2)
        }
        .padding(VSpacing.lg)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(Color.white.opacity(0.02))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .strokeBorder(VColor.surfaceBorder, lineWidth: 1)
                )
        )
    }

    // MARK: - TTS Section Divider

    private var ttsDivider: some View {
        HStack(spacing: VSpacing.md) {
            Text("TEXT-TO-SPEECH")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(VColor.textMuted)
                .tracking(1)

            Rectangle()
                .fill(VColor.surfaceBorder)
                .frame(height: 1)
        }
    }

    // MARK: - TTS Status

    private var ttsStatusSection: some View {
        HStack(spacing: VSpacing.sm) {
            Circle()
                .fill(store.hasElevenLabsKey ? VColor.success : VColor.textMuted)
                .frame(width: 8, height: 8)

            Text(store.hasElevenLabsKey ? "ElevenLabs API key saved" : "ElevenLabs not configured")
                .font(VFont.body)
                .foregroundColor(store.hasElevenLabsKey ? VColor.success : VColor.textSecondary)

            Spacer()
        }
        .padding(VSpacing.lg)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(store.hasElevenLabsKey ? VColor.success.opacity(0.08) : VColor.surfaceSubtle)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .strokeBorder(store.hasElevenLabsKey ? VColor.success.opacity(0.2) : VColor.surfaceBorder, lineWidth: 1)
                )
        )
    }

    // MARK: - TTS Key Section

    private var ttsKeySection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("ElevenLabs API Key")
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.textPrimary)

            Text("ElevenLabs provides high-quality voice responses during voice conversations. An API key is required.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            if store.hasElevenLabsKey {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                        .font(.system(size: 14))
                    Text(store.maskedElevenLabsKey)
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    VButton(label: "Remove", style: .danger) {
                        store.clearElevenLabsKey()
                        elevenLabsKeyText = ""
                    }
                }
            } else {
                SecureField("Your ElevenLabs API key", text: $elevenLabsKeyText)
                    .vInputStyle()
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)

                VButton(label: "Save", style: .primary) {
                    store.saveElevenLabsKey(elevenLabsKeyText)
                    elevenLabsKeyText = ""
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - TTS Privacy Note

    private var ttsPrivacyNote: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            Image(systemName: "lock.fill")
                .font(.system(size: 10))
                .foregroundColor(VColor.textMuted)

            Text("Your API key is stored securely in the macOS Keychain and is only used to generate voice responses.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .lineSpacing(2)
        }
    }
}

import SwiftUI
import VellumAssistantShared

/// Wake word settings tab — enable/disable wake word listening,
/// configure keyword phrase, and conversation timeout.
struct WakeWordSettingsView: View {
    @AppStorage("wakeWordEnabled") private var wakeWordEnabled: Bool = false
    @AppStorage("wakeWordTimeoutSeconds") private var wakeWordTimeoutSeconds: Int = 30
    @AppStorage("wakeWordKeyword") private var wakeWordKeyword: String = "computer"

    private let suggestedKeywords = ["computer", "jarvis", "hey vellum", "assistant"]

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            statusSection
            enableSection
            keywordSection
            timeoutSection
        }
    }

    // MARK: - Status

    private var statusSection: some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: wakeWordEnabled ? "waveform" : "waveform.slash")
                .font(.system(size: 14))
                .foregroundColor(wakeWordEnabled ? VColor.success : VColor.textMuted)

            Text(wakeWordEnabled ? "Listening for \"\(wakeWordKeyword)\"" : "Wake word disabled")
                .font(VFont.body)
                .foregroundColor(wakeWordEnabled ? VColor.textPrimary : VColor.textSecondary)

            Spacer()
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Enable/Disable

    private var enableSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Wake Word")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Enable wake word listening")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Text("Activate the assistant by saying the wake word instead of using a keyboard shortcut.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                Spacer()
                Toggle("", isOn: $wakeWordEnabled)
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .accessibilityLabel("Enable wake word listening")
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Keyword

    private var keywordSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Keyword")
                .font(VFont.sectionTitle)
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
                    .foregroundColor(wakeWordKeyword == suggestion ? VColor.accent : VColor.textMuted)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.sm)
                            .fill(wakeWordKeyword == suggestion ? VColor.accentSubtle : VColor.surface)
                    )
                }
            }

            Text("Type any word or phrase. Uses on-device speech recognition — no data leaves your Mac.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Timeout

    private var timeoutSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Conversation Timeout")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            HStack {
                Text("Auto-end conversation after")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
                Picker("", selection: $wakeWordTimeoutSeconds) {
                    Text("15 seconds").tag(15)
                    Text("30 seconds").tag(30)
                    Text("60 seconds").tag(60)
                    Text("120 seconds").tag(120)
                }
                .pickerStyle(.menu)
                .frame(width: 160)
                .accessibilityLabel("Conversation timeout duration")
            }

            Text("How long to wait for follow-up speech before ending the conversation.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }
}

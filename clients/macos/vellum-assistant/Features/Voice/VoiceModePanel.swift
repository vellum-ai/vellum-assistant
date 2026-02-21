import SwiftUI
import VellumAssistantShared

struct VoiceModePanel: View {
    @ObservedObject var manager: VoiceModeManager
    @ObservedObject var voiceService: OpenAIVoiceService
    let onClose: () -> Void

    @State private var appearance = AvatarAppearanceManager.shared
    @State private var showingInfo = false

    private let avatarSize: CGFloat = 100
    private let avatarPixelSize: CGFloat = 4

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                HStack(spacing: VSpacing.sm) {
                    Text("VOICE")
                        .font(VFont.display)
                        .foregroundColor(VColor.textPrimary)
                    Text("BETA")
                        .font(VFont.small)
                        .foregroundColor(VColor.accent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(VColor.accent.opacity(0.15))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
                Spacer()
                Button(action: { showingInfo.toggle() }) {
                    Image(systemName: "info.circle")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundColor(VColor.textSecondary)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(VColor.textSecondary)
                        .frame(width: 28, height: 28)
                        .background(VColor.surface.opacity(0.8))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.top, VSpacing.xl)
            .padding(.bottom, VSpacing.lg)

            // Info panel
            if showingInfo {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    infoRow(label: "STT", value: "OpenAI Whisper")
                    infoRow(label: "LLM", value: "Your selected model")
                    infoRow(label: "TTS", value: "ElevenLabs Flash v2.5")
                    Divider().background(VColor.surfaceBorder)
                    Text("Voice mode transcribes your speech, sends it to your assistant, and speaks the response. Tool permissions are handled via voice — say \"yes\" or \"no\" when asked.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                .padding(VSpacing.lg)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .padding(.horizontal, VSpacing.xl)
                .padding(.bottom, VSpacing.lg)
            }

            Spacer()

            if !manager.hasAPIKey {
                // No API key configured
                VStack(spacing: VSpacing.lg) {
                    Image(systemName: "key.fill")
                        .font(.system(size: 32))
                        .foregroundColor(VColor.textMuted)
                    Text("OpenAI API key required")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.textSecondary)
                    Text("Add your OpenAI API key in Settings to use voice mode with Whisper and TTS.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, VSpacing.xl)
                }
            } else {
                // Avatar
                ZStack {
                    Circle()
                        .stroke(strokeColor, lineWidth: 3)
                        .frame(width: avatarSize, height: avatarSize)
                        .scaleEffect(manager.state == .listening ? 1.05 : 1.0)
                        .animation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true), value: manager.state == .listening)

                    Image(nsImage: PixelSpriteBuilder.buildBlobNSImage(pixelSize: avatarPixelSize, palette: appearance.palette))
                        .interpolation(.none)
                }
                .padding(.bottom, VSpacing.xl)

                // Waveform
                VWaveformView(
                    amplitude: effectiveAmplitude,
                    barCount: 30,
                    isActive: manager.state == .listening || manager.state == .speaking,
                    accentColor: waveformColor
                )
                .frame(height: 44)
                .padding(.horizontal, VSpacing.xl)
                .padding(.bottom, VSpacing.lg)

                // State label
                Text(manager.stateLabel)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textSecondary)
                    .padding(.bottom, VSpacing.sm)

                // Error message
                if !manager.errorMessage.isEmpty {
                    HStack(spacing: VSpacing.sm) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundColor(VColor.warning)
                            .font(.system(size: 14))
                        Text(manager.errorMessage)
                            .font(VFont.caption)
                            .foregroundColor(VColor.warning)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.horizontal, VSpacing.xl)
                    .padding(.vertical, VSpacing.md)
                    .background(VColor.warning.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .padding(.horizontal, VSpacing.xl)
                    .padding(.bottom, VSpacing.lg)
                }

                // Partial transcription
                if !manager.partialTranscription.isEmpty {
                    ScrollView {
                        Text(manager.partialTranscription)
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, VSpacing.xl)
                    }
                    .frame(maxHeight: 80)
                    .padding(.bottom, VSpacing.lg)
                }
            }

            Spacer()

            // Controls
            if manager.hasAPIKey {
                VStack(spacing: VSpacing.md) {
                    // Mic toggle button
                    Button(action: { manager.toggleListening() }) {
                        Image(systemName: micIcon)
                            .font(.system(size: 20, weight: .medium))
                            .foregroundColor(micButtonForeground)
                            .frame(width: 56, height: 56)
                            .background(micButtonBackground)
                            .clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(manager.state == .processing)

                    // End voice mode button
                    Button(action: onClose) {
                        Text("End Voice Mode")
                            .font(VFont.captionMedium)
                            .foregroundColor(VColor.textMuted)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.bottom, VSpacing.xxl)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(VColor.background)
    }

    private var strokeColor: Color {
        switch manager.state {
        case .listening: return VColor.accent
        case .speaking: return VColor.success
        case .processing: return VColor.textMuted
        default: return VColor.surfaceBorder
        }
    }

    private var effectiveAmplitude: Float {
        switch manager.state {
        case .listening: return voiceService.amplitude
        case .speaking: return voiceService.speakingAmplitude
        default: return 0
        }
    }

    private var waveformColor: Color {
        manager.state == .speaking ? VColor.success : VColor.accent
    }

    private var micIcon: String {
        manager.state == .listening ? "mic.fill" : "mic"
    }

    private var micButtonForeground: Color {
        manager.state == .listening ? .white : VColor.textPrimary
    }

    private var micButtonBackground: Color {
        manager.state == .listening ? VColor.accent : VColor.surface
    }

    private func infoRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textMuted)
                .frame(width: 32, alignment: .leading)
            Text(value)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
        }
    }
}

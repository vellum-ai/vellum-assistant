import SwiftUI
import VellumAssistantShared

/// Compact inline voice mode bar displayed below the composer.
struct VoiceModeBar: View {
    @ObservedObject var manager: VoiceModeManager
    @ObservedObject var voiceService: OpenAIVoiceService
    let onEnd: () -> Void

    @State private var waveformPhase: Double = 0

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            // Avatar / status icon
            Image(systemName: "waveform.circle.fill")
                .font(.system(size: 18, weight: .medium))
                .foregroundColor(statusIconColor)

            // Status text or live transcription
            Group {
                if manager.state == .listening, !manager.liveTranscription.isEmpty {
                    Text(manager.liveTranscription)
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                } else {
                    Text(manager.stateLabel)
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.textSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // Waveform amplitude bars
            waveformBars
                .frame(width: 28, height: 20)

            // Mute / unmute button
            Button(action: { manager.toggleListening() }) {
                Image(systemName: manager.state == .listening ? "mic.fill" : "mic.slash.fill")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(manager.state == .listening ? VColor.textPrimary : VColor.textSecondary)
                    .frame(width: 34, height: 34)
                    .background(VColor.surface.opacity(0.6))
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            }
            .buttonStyle(.plain)
            .disabled(manager.state == .processing)
            .accessibilityLabel(manager.state == .listening ? "Mute microphone" : "Unmute microphone")

            // End voice mode button
            Button(action: onEnd) {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(.white)
                    .frame(width: 34, height: 34)
                    .background(VColor.error)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("End voice mode")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(adaptiveColor(light: Moss._200, dark: Moss._700))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(adaptiveColor(light: Moss._300, dark: Moss._600), lineWidth: 1)
                )
        )
        .padding(.horizontal, VSpacing.lg)
        .padding(.bottom, VSpacing.sm)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    // MARK: - Waveform

    private var waveformBars: some View {
        HStack(spacing: 2) {
            ForEach(0..<4, id: \.self) { i in
                RoundedRectangle(cornerRadius: 1)
                    .fill(waveformColor)
                    .frame(width: 3, height: waveformBarHeight(index: i))
            }
        }
    }

    private func waveformBarHeight(index: Int) -> CGFloat {
        let amp: Float
        switch manager.state {
        case .listening:
            amp = voiceService.amplitude
        case .speaking:
            amp = voiceService.speakingAmplitude
        default:
            return 4
        }

        let base: CGFloat = 4
        let maxExtra: CGFloat = 16
        // Offset each bar slightly for visual variety
        let offset = Float(index) * 0.2
        let value = min(max(amp + offset * amp, 0), 1)
        return base + CGFloat(value) * maxExtra
    }

    private var waveformColor: Color {
        switch manager.state {
        case .listening: return VColor.accent
        case .speaking: return VColor.success
        default: return VColor.textMuted
        }
    }

    private var statusIconColor: Color {
        switch manager.state {
        case .listening: return VColor.accent
        case .speaking: return VColor.success
        case .processing: return VColor.textSecondary
        default: return Moss._500
        }
    }
}

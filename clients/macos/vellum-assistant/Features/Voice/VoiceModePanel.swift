import SwiftUI
import VellumAssistantShared

struct VoiceModePanel: View {
    @ObservedObject var manager: VoiceModeManager
    @ObservedObject var voiceService: OpenAIVoiceService
    let onClose: () -> Void

    @State private var showingInfo = false
    @State private var spinAngle: Double = 0
    @State private var ringJitter: [CGFloat] = [0, 0, 0]
    @State private var jitterTimer: Timer?

    private let orbSize: CGFloat = 120

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
                .accessibilityLabel(showingInfo ? "Hide info" : "Show info")
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(VColor.textSecondary)
                        .frame(width: 28, height: 28)
                        .background(VColor.surface.opacity(0.8))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close voice mode")
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
                    Text("Voice mode transcribes your speech, sends it to your assistant, and speaks the response. Tool permissions are handled via voice \u{2014} say \"yes\" or \"no\" when asked.")
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
                // Voice orb
                voiceOrb
                    .padding(.bottom, VSpacing.xxl)

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

            }

            Spacer()

            // Controls
            if manager.hasAPIKey {
                VStack(spacing: VSpacing.md) {
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
        .onChange(of: manager.state) { _, newState in
            if newState == .listening || newState == .speaking {
                startRingJitter(for: newState)
            } else {
                stopRingJitter()
            }
        }
        .onDisappear {
            stopRingJitter()
        }
    }

    private func startRingJitter(for state: VoiceModeManager.State) {
        jitterTimer?.invalidate()
        let isListening = state == .listening
        // Listening: fast reactive jitter; Speaking: gentle smooth pulse
        let interval: TimeInterval = isListening ? 0.07 : 0.12
        jitterTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { _ in
            Task { @MainActor in
                if isListening {
                    let amp = CGFloat(voiceService.amplitude)
                    let intensity: CGFloat = 3 + amp * 12
                    withAnimation(.easeInOut(duration: 0.07)) {
                        ringJitter = (0..<3).map { _ in CGFloat.random(in: -intensity...intensity) }
                    }
                } else {
                    // Gentle smooth wave for speaking
                    let intensity: CGFloat = 4
                    withAnimation(.easeInOut(duration: 0.3)) {
                        ringJitter = (0..<3).map { _ in CGFloat.random(in: -intensity...intensity) }
                    }
                }
            }
        }
    }

    private func stopRingJitter() {
        jitterTimer?.invalidate()
        jitterTimer = nil
        withAnimation(.easeOut(duration: 0.2)) {
            ringJitter = [0, 0, 0]
        }
    }

    // MARK: - Voice Orb

    private var voiceOrb: some View {
        let amp = CGFloat(effectiveAmplitude)

        return ZStack {
            // Ripple rings that expand with amplitude + jitter when listening
            if manager.state == .listening || manager.state == .speaking {
                ForEach(0..<3, id: \.self) { i in
                    let jitter = i < ringJitter.count ? ringJitter[i] : 0
                    let ringOffset = CGFloat(i + 1) * 24 * (amp + 0.3) + jitter
                    Circle()
                        .stroke(orbColor.opacity(0.12 - Double(i) * 0.025), lineWidth: manager.state == .listening ? 2 : 1.5)
                        .frame(width: orbSize + ringOffset, height: orbSize + ringOffset)
                }
            }

            // Soft glow behind the orb
            Circle()
                .fill(orbColor.opacity(0.15))
                .frame(width: orbSize + 20, height: orbSize + 20)
                .blur(radius: 24)

            // Main orb with gradient
            Circle()
                .fill(
                    RadialGradient(
                        colors: orbGradient,
                        center: .center,
                        startRadius: 0,
                        endRadius: orbSize / 2
                    )
                )
                .frame(width: orbSize, height: orbSize)
                .scaleEffect(orbScale)

            // Specular highlight
            Circle()
                .fill(
                    RadialGradient(
                        colors: [.white.opacity(0.18), .clear],
                        center: .init(x: 0.35, y: 0.3),
                        startRadius: 0,
                        endRadius: orbSize / 3
                    )
                )
                .frame(width: orbSize, height: orbSize)

            // Processing spinner arc
            if manager.state == .processing {
                Circle()
                    .trim(from: 0, to: 0.25)
                    .stroke(.white.opacity(0.35), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .frame(width: orbSize - 14, height: orbSize - 14)
                    .rotationEffect(.degrees(spinAngle))
                    .onAppear {
                        spinAngle = 0
                        withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) {
                            spinAngle = 360
                        }
                    }
            }

            // Center icon
            Image(systemName: orbIcon)
                .font(.system(size: 26, weight: .medium))
                .foregroundColor(.white.opacity(0.9))
        }
        .animation(.easeInOut(duration: manager.state == .speaking ? 0.3 : 0.12), value: amp)
        .animation(manager.state == .processing
                   ? .easeInOut(duration: 1.8).repeatForever(autoreverses: true)
                   : .easeInOut(duration: manager.state == .speaking ? 0.3 : 0.12),
                   value: orbScale)
    }

    // MARK: - Orb Properties

    private var orbColor: Color {
        switch manager.state {
        case .listening: return VColor.accent
        case .speaking: return VColor.success
        case .processing: return Forest._700
        default: return Moss._500
        }
    }

    private var orbGradient: [Color] {
        switch manager.state {
        case .listening: return [Forest._500, Forest._700]
        case .speaking: return [Emerald._500, Emerald._700]
        case .processing: return [Forest._600, Forest._800]
        default: return [Moss._500, Moss._400]
        }
    }

    private var orbScale: CGFloat {
        switch manager.state {
        case .listening: return 1.0 + CGFloat(effectiveAmplitude) * 0.12
        case .speaking: return 1.0 + CGFloat(effectiveAmplitude) * 0.08
        case .processing: return 0.95
        default: return 1.0
        }
    }

    private var orbIcon: String {
        switch manager.state {
        case .listening: return "waveform"
        case .speaking: return "speaker.wave.2.fill"
        case .processing: return "ellipsis"
        default: return "waveform"
        }
    }

    // MARK: - Helpers

    private var effectiveAmplitude: Float {
        switch manager.state {
        case .listening: return voiceService.amplitude
        case .speaking: return voiceService.speakingAmplitude
        default: return 0
        }
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

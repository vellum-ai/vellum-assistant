#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// MARK: - Voice Orb State

enum VoiceOrbState: Equatable {
    case idle
    case listening
    case thinking
    case speaking
}

// MARK: - Voice Orb View

/// Animated voice orb with ring-jitter effects and state labels, ported from the macOS VoiceModePanel.
///
/// The orb renders three concentric expanding rings when active (listening or speaking), a radial
/// gradient body whose color shifts per state, a specular highlight, and a spinning arc during
/// the thinking state. Ring jitter intensity is driven by the current audio amplitude so the orb
/// reacts visually to the user's voice.
struct VoiceOrbView: View {
    let state: VoiceOrbState
    /// Normalized audio input amplitude [0,1] while listening.
    var listeningAmplitude: Float = 0
    /// Normalized playback amplitude [0,1] while speaking.
    var speakingAmplitude: Float = 0

    @State private var spinAngle: Double = 0
    @State private var ringJitter: [CGFloat] = [0, 0, 0]
    @State private var jitterTimer: Timer?
    // Mutable @State copies of the incoming amplitudes so the timer closure can read
    // the current value on every tick. SwiftUI struct properties are copied by value
    // into closures at capture time; @State provides stable heap-allocated storage that
    // the timer sees fresh on each fire.
    @State private var currentListeningAmplitude: Float = 0
    @State private var currentSpeakingAmplitude: Float = 0

    private let orbSize: CGFloat = 72

    var body: some View {
        VStack(spacing: VSpacing.sm) {
            orb
            stateLabel
        }
        .onChange(of: state) { _, newState in
            if newState == .listening || newState == .speaking {
                startRingJitter(for: newState)
            } else {
                stopRingJitter()
            }
        }
        // Keep the @State amplitude mirrors in sync so the timer closure always reads
        // the live value rather than a stale copy from the last struct update.
        .onChange(of: listeningAmplitude) { _, newValue in
            currentListeningAmplitude = newValue
        }
        .onChange(of: speakingAmplitude) { _, newValue in
            currentSpeakingAmplitude = newValue
        }
        .onDisappear {
            stopRingJitter()
        }
    }

    // MARK: - Orb

    private var orb: some View {
        let amp = CGFloat(effectiveAmplitude)

        return ZStack {
            // Ripple rings — expand with amplitude + jitter when active
            if state == .listening || state == .speaking {
                ForEach(0..<3, id: \.self) { i in
                    let jitter = i < ringJitter.count ? ringJitter[i] : 0
                    let ringOffset = CGFloat(i + 1) * 16 * (amp + 0.3) + jitter
                    Circle()
                        .stroke(orbColor.opacity(0.12 - Double(i) * 0.025),
                                lineWidth: state == .listening ? 2 : 1.5)
                        .frame(width: orbSize + ringOffset, height: orbSize + ringOffset)
                }
            }

            // Soft glow behind the orb
            Circle()
                .fill(orbColor.opacity(0.15))
                .frame(width: orbSize + 14, height: orbSize + 14)
                .blur(radius: 16)

            // Main orb with radial gradient
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

            // Specular highlight — subtle gloss on the upper-left
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

            // Spinner arc during thinking state
            if state == .thinking {
                Circle()
                    .trim(from: 0, to: 0.25)
                    .stroke(.white.opacity(0.35),
                            style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .frame(width: orbSize - 10, height: orbSize - 10)
                    .rotationEffect(.degrees(spinAngle))
                    .onAppear {
                        spinAngle = 0
                        withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) {
                            spinAngle = 360
                        }
                    }
            }

            // Center icon
            VIconView(orbIcon, size: 18)
                .foregroundColor(.white.opacity(0.9))
        }
        .frame(width: orbSize + 60, height: orbSize + 60)
        .animation(.easeInOut(duration: state == .speaking ? 0.3 : 0.12), value: amp)
        .animation(
            state == .thinking
                ? .easeInOut(duration: 1.8).repeatForever(autoreverses: true)
                : .easeInOut(duration: state == .speaking ? 0.3 : 0.12),
            value: orbScale
        )
    }

    // MARK: - State Label

    private var stateLabel: some View {
        Text(stateLabelText)
            .font(VFont.caption)
            .foregroundColor(VColor.contentSecondary)
            .animation(VAnimation.standard, value: stateLabelText)
    }

    private var stateLabelText: String {
        switch state {
        case .idle:      return "Tap to speak"
        case .listening: return "Listening..."
        case .thinking:  return "Thinking..."
        case .speaking:  return "Speaking..."
        }
    }

    // MARK: - Orb Properties

    private var orbColor: Color {
        switch state {
        case .listening: return VColor.primaryBase
        case .speaking:  return VColor.systemPositiveStrong
        case .thinking:  return VColor.primaryHover
        case .idle:      return VColor.contentDisabled
        }
    }

    private var orbGradient: [Color] {
        switch state {
        case .listening: return [VColor.primaryActive, VColor.primaryHover]
        case .speaking:  return [VColor.systemPositiveStrong, VColor.systemPositiveStrong]
        case .thinking:  return [VColor.primaryBase, VColor.borderActive]
        case .idle:      return [VColor.contentDisabled, VColor.contentTertiary]
        }
    }

    private var orbScale: CGFloat {
        switch state {
        case .listening: return 1.0 + CGFloat(effectiveAmplitude) * 0.12
        case .speaking:  return 1.0 + CGFloat(effectiveAmplitude) * 0.08
        case .thinking:  return 0.95
        case .idle:      return 1.0
        }
    }

    private var orbIcon: VIcon {
        switch state {
        case .listening: return .audioWaveform
        case .speaking:  return .volume2
        case .thinking:  return .ellipsis
        case .idle:      return .audioWaveform
        }
    }

    private var effectiveAmplitude: Float {
        switch state {
        case .listening: return listeningAmplitude
        case .speaking:  return speakingAmplitude
        default:         return 0
        }
    }

    // MARK: - Ring Jitter

    private func startRingJitter(for newState: VoiceOrbState) {
        jitterTimer?.invalidate()
        let isListening = newState == .listening
        // Listening: fast reactive jitter matching voice input; speaking: gentle pulse
        let interval: TimeInterval = isListening ? 0.07 : 0.12
        jitterTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { _ in
            Task { @MainActor in
                if isListening {
                    // Read currentListeningAmplitude — the @State mirror updated by onChange —
                    // so the intensity reflects the live audio level on every tick.
                    // @State uses heap-allocated storage, so the closure captures a reference
                    // to the same box even though VoiceOrbView is a struct.
                    let amp = CGFloat(currentListeningAmplitude)
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
}

// MARK: - Preview

#Preview {
    VStack(spacing: 40) {
        HStack(spacing: 32) {
            VoiceOrbView(state: .idle)
            VoiceOrbView(state: .listening, listeningAmplitude: 0.6)
        }
        HStack(spacing: 32) {
            VoiceOrbView(state: .thinking)
            VoiceOrbView(state: .speaking, speakingAmplitude: 0.5)
        }
    }
    .padding(40)
    .background(VColor.surfaceOverlay)
}
#endif

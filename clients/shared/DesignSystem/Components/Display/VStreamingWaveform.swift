import SwiftUI

// MARK: - Waveform Style

/// Defines the visual style of the streaming waveform.
public enum WaveformStyle {
    /// Dense centered bars for voice mode.
    case conversation
    /// Subtler bottom-aligned bars for inline recording strip.
    case dictation
}

// MARK: - VStreamingWaveform

/// A streaming waveform visualizer that renders animated bars driven by an audio amplitude signal.
///
/// Uses `Canvas` + `TimelineView(.animation)` for smooth 60fps rendering isolated from
/// broader view invalidations.
public struct VStreamingWaveform: View {
    /// Audio amplitude, clamped to 0...1.
    public var amplitude: Float
    /// Whether the waveform is actively receiving audio input.
    public var isActive: Bool
    /// Visual style of the waveform.
    public var style: WaveformStyle
    /// Bar color.
    public var foregroundColor: Color
    /// Number of bars to render.
    public var barCount: Int
    /// Width of each bar.
    public var lineWidth: CGFloat

    public init(
        amplitude: Float,
        isActive: Bool,
        style: WaveformStyle = .conversation,
        foregroundColor: Color = VColor.accent,
        barCount: Int = 5,
        lineWidth: CGFloat = 3
    ) {
        self.amplitude = amplitude
        self.isActive = isActive
        self.style = style
        self.foregroundColor = foregroundColor
        self.barCount = barCount
        self.lineWidth = lineWidth
    }

    public var body: some View {
        TimelineView(.animation) { timeline in
            Canvas { context, size in
                let date = timeline.date.timeIntervalSinceReferenceDate
                draw(context: context, size: size, time: date)
            }
        }
    }

    // MARK: - Drawing

    private func draw(context: GraphicsContext, size: CGSize, time: TimeInterval) {
        guard barCount > 0 else { return }

        let clampedAmplitude = CGFloat(min(max(amplitude, 0), 1))
        let totalBarWidth = CGFloat(barCount) * lineWidth
        let totalSpacing = CGFloat(barCount - 1) * VSpacing.xs
        let totalWidth = totalBarWidth + totalSpacing
        let startX = (size.width - totalWidth) / 2

        let isConversation = style == .conversation
        let maxBarHeight: CGFloat = isConversation ? size.height * 0.8 : size.height * 0.5
        let minBarHeight: CGFloat = isConversation ? lineWidth * 1.5 : lineWidth

        for i in 0..<barCount {
            let phaseOffset = Double(i) * 0.6
            let wave = sin(time * 4.0 + phaseOffset) * 0.5 + 0.5 // 0...1

            let activeHeight: CGFloat
            if isActive {
                let amplitudeContribution = clampedAmplitude * 0.7
                let waveContribution = CGFloat(wave) * 0.3
                let normalizedHeight = amplitudeContribution + waveContribution * clampedAmplitude
                activeHeight = minBarHeight + normalizedHeight * (maxBarHeight - minBarHeight)
            } else {
                // Settle to baseline
                let subtleWave = CGFloat(sin(time * 2.0 + phaseOffset) * 0.5 + 0.5) * 0.15
                activeHeight = minBarHeight + subtleWave * minBarHeight
            }

            let barHeight = max(activeHeight, minBarHeight)
            let x = startX + CGFloat(i) * (lineWidth + VSpacing.xs)

            let barRect: CGRect
            if isConversation {
                // Centered vertically
                let y = (size.height - barHeight) / 2
                barRect = CGRect(x: x, y: y, width: lineWidth, height: barHeight)
            } else {
                // Bottom-aligned
                let y = size.height - barHeight
                barRect = CGRect(x: x, y: y, width: lineWidth, height: barHeight)
            }

            let cornerRadius = isConversation ? lineWidth / 2 : lineWidth / 3
            let path = Path(roundedRect: barRect, cornerRadius: cornerRadius)
            context.fill(path, with: .color(foregroundColor))
        }
    }
}

// MARK: - Preview

private struct WaveformPreviewContainer: View {
    @State private var amplitude: Float = 0.5
    @State private var isActive: Bool = true

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Text("Conversation Style")
                .font(.headline)
                .foregroundColor(VColor.textPrimary)
            VStreamingWaveform(
                amplitude: amplitude,
                isActive: isActive,
                style: .conversation
            )
            .frame(width: 120, height: 60)

            Text("Dictation Style")
                .font(.headline)
                .foregroundColor(VColor.textPrimary)
            VStreamingWaveform(
                amplitude: amplitude,
                isActive: isActive,
                style: .dictation,
                foregroundColor: VColor.textSecondary
            )
            .frame(width: 100, height: 30)

            Divider()

            HStack {
                Text("Amplitude: \(String(format: "%.2f", amplitude))")
                    .foregroundColor(VColor.textSecondary)
                Slider(value: Binding(
                    get: { Double(amplitude) },
                    set: { amplitude = Float($0) }
                ), in: 0...1)
            }
            .padding(.horizontal)

            Toggle("Active", isOn: $isActive)
                .padding(.horizontal)
                .foregroundColor(VColor.textPrimary)
        }
        .padding()
    }
}

#Preview("VStreamingWaveform") {
    ZStack {
        VColor.background.ignoresSafeArea()
        WaveformPreviewContainer()
    }
    .frame(width: 300, height: 350)
}

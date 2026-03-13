import SwiftUI

// MARK: - Waveform Style

/// Defines the visual style of the streaming waveform.
public enum WaveformStyle {
    /// Dense centered bars for voice mode.
    case conversation
    /// Subtler bottom-aligned bars for inline recording strip.
    case dictation
    /// Right-to-left scrolling amplitude history (like ChatGPT voice input).
    case scrolling
}

// MARK: - Scrolling State

/// Holds the amplitude sample history for the scrolling waveform style.
/// Using a reference type so Canvas can append samples during draw without
/// needing @State mutation (which isn't allowed inside Canvas closures).
private final class ScrollingWaveformState {
    var samples: [Float] = []
    var lastSampleTime: TimeInterval = 0

    func update(amplitude: Float, maxBars: Int, time: TimeInterval, sampleInterval: TimeInterval) {
        guard time - lastSampleTime >= sampleInterval else { return }
        lastSampleTime = time
        samples.append(amplitude)
        if samples.count > maxBars {
            samples.removeFirst(samples.count - maxBars)
        }
    }

    func reset() {
        samples.removeAll()
        lastSampleTime = 0
    }
}

// MARK: - VStreamingWaveform

/// A streaming waveform visualizer that renders animated bars driven by an audio amplitude signal.
///
/// Uses `Canvas` + `TimelineView(.animation)` for smooth 60fps rendering isolated from
/// broader view invalidations.
///
/// In `.scrolling` style, new amplitude samples appear on the right and scroll left,
/// building up a visual history of the audio input.
public struct VStreamingWaveform: View {
    /// Audio amplitude, clamped to 0...1.
    public var amplitude: Float
    /// Whether the waveform is actively receiving audio input.
    public var isActive: Bool
    /// Visual style of the waveform.
    public var style: WaveformStyle
    /// Bar color.
    public var foregroundColor: Color
    /// Number of bars to render (ignored for `.scrolling` style, which fills available width).
    public var barCount: Int
    /// Width of each bar.
    public var lineWidth: CGFloat

    @State private var scrollingState = ScrollingWaveformState()

    public init(
        amplitude: Float,
        isActive: Bool,
        style: WaveformStyle = .conversation,
        foregroundColor: Color = VColor.primaryBase,
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
                if style == .scrolling {
                    drawScrolling(context: context, size: size, time: date)
                } else {
                    draw(context: context, size: size, time: date)
                }
            }
        }
        .onChange(of: isActive) { _, active in
            if !active {
                scrollingState.reset()
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(isActive ? "Audio waveform, active" : "Audio waveform, inactive")
    }

    // MARK: - Scrolling Drawing

    private func drawScrolling(context: GraphicsContext, size: CGSize, time: TimeInterval) {
        let barSpacing: CGFloat = 2
        let effectiveBarCount = max(1, Int(size.width / (lineWidth + barSpacing)))

        // Push a new amplitude sample at ~30Hz
        if isActive {
            scrollingState.update(
                amplitude: min(max(amplitude, 0), 1),
                maxBars: effectiveBarCount,
                time: time,
                sampleInterval: 0.033
            )
        }

        let samples = scrollingState.samples
        guard !samples.isEmpty else {
            // Draw baseline dots when no samples yet
            drawScrollingBaseline(context: context, size: size, barCount: effectiveBarCount, barSpacing: barSpacing)
            return
        }

        let maxBarHeight = size.height * 0.85
        let minBarHeight = max(lineWidth, 2)
        let cornerRadius = lineWidth / 2

        // Draw bars right-aligned: newest sample on the right
        let sampleCount = samples.count
        for i in 0..<sampleCount {
            let sampleValue = CGFloat(samples[i])
            let barHeight = max(minBarHeight + sampleValue * (maxBarHeight - minBarHeight), minBarHeight)

            // Position from the right
            let barIndex = effectiveBarCount - sampleCount + i
            guard barIndex >= 0 else { continue }
            let x = CGFloat(barIndex) * (lineWidth + barSpacing)

            // Centered vertically
            let y = (size.height - barHeight) / 2
            let barRect = CGRect(x: x, y: y, width: lineWidth, height: barHeight)
            let path = Path(roundedRect: barRect, cornerRadius: cornerRadius)
            context.fill(path, with: .color(foregroundColor))
        }

        // Draw faint baseline dots for unfilled positions
        let filledStart = effectiveBarCount - sampleCount
        if filledStart > 0 {
            for i in 0..<filledStart {
                let x = CGFloat(i) * (lineWidth + barSpacing)
                let y = (size.height - minBarHeight) / 2
                let barRect = CGRect(x: x, y: y, width: lineWidth, height: minBarHeight)
                let path = Path(roundedRect: barRect, cornerRadius: cornerRadius)
                context.fill(path, with: .color(foregroundColor.opacity(0.25)))
            }
        }
    }

    private func drawScrollingBaseline(context: GraphicsContext, size: CGSize, barCount: Int, barSpacing: CGFloat) {
        let minBarHeight = max(lineWidth, 2)
        let cornerRadius = lineWidth / 2

        for i in 0..<barCount {
            let x = CGFloat(i) * (lineWidth + barSpacing)
            let y = (size.height - minBarHeight) / 2
            let barRect = CGRect(x: x, y: y, width: lineWidth, height: minBarHeight)
            let path = Path(roundedRect: barRect, cornerRadius: cornerRadius)
            context.fill(path, with: .color(foregroundColor.opacity(0.25)))
        }
    }

    // MARK: - Conversation / Dictation Drawing

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


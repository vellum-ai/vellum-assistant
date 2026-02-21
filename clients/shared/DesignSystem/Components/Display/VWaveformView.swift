import SwiftUI

/// Animated waveform visualization — a row of bars that fluctuate with amplitude.
public struct VWaveformView: View {
    let amplitude: Float
    var barCount: Int
    let isActive: Bool
    var accentColor: Color

    @State private var barOffsets: [Float] = []
    @State private var animationTimer: Timer?

    public init(amplitude: Float, barCount: Int = 40, isActive: Bool, accentColor: Color = VColor.accent) {
        self.amplitude = amplitude
        self.barCount = barCount
        self.isActive = isActive
        self.accentColor = accentColor
    }

    public var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<barCount, id: \.self) { index in
                barView(at: index)
            }
        }
        .onAppear {
            if barOffsets.isEmpty {
                barOffsets = (0..<barCount).map { _ in Float.random(in: 0...1) }
            }
            startAnimation()
        }
        .onDisappear {
            animationTimer?.invalidate()
            animationTimer = nil
        }
        .onChange(of: isActive) { _, active in
            if active {
                startAnimation()
            } else {
                animationTimer?.invalidate()
                animationTimer = nil
            }
        }
    }

    @ViewBuilder
    private func barView(at index: Int) -> some View {
        let offset = index < barOffsets.count ? barOffsets[index] : 0.5
        let baseHeight: CGFloat = 4
        let maxAdditional: CGFloat = 36

        let effectiveAmplitude: CGFloat = if isActive {
            CGFloat(amplitude) * CGFloat(offset)
        } else {
            // Gentle ambient wave when idle
            CGFloat(offset) * 0.15
        }

        let height = baseHeight + maxAdditional * effectiveAmplitude

        RoundedRectangle(cornerRadius: 1.5)
            .fill(isActive ? accentColor : VColor.textMuted.opacity(0.3))
            .frame(width: 3, height: height)
            .animation(.easeInOut(duration: 0.1), value: height)
    }

    private func startAnimation() {
        animationTimer?.invalidate()
        animationTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { _ in
            Task { @MainActor in
                var newOffsets = [Float]()
                for i in 0..<barCount {
                    let current = i < barOffsets.count ? barOffsets[i] : 0.5
                    // Smoothly drift toward a new random target
                    let target = Float.random(in: 0...1)
                    newOffsets.append(current * 0.6 + target * 0.4)
                }
                withAnimation(.easeInOut(duration: 0.1)) {
                    barOffsets = newOffsets
                }
            }
        }
    }
}

import SwiftUI

struct VSlider: View {
    @Binding var value: Double
    var range: ClosedRange<Double> = 0...100
    var step: Double = 1
    var showTickMarks: Bool = false

    // MARK: - Layout Constants

    private let trackHeight: CGFloat = 6
    private let thumbWidth: CGFloat = 20
    private let thumbHeight: CGFloat = 24
    private let tickMarkHeight: CGFloat = 8
    private let tickMarkWidth: CGFloat = 1
    private let gripLineCount: Int = 3
    private let gripLineWidth: CGFloat = 1
    private let gripLineHeight: CGFloat = 10
    private let gripLineSpacing: CGFloat = 2.5

    // MARK: - State

    @State private var isDragging = false

    // MARK: - Body

    var body: some View {
        GeometryReader { geometry in
            let trackWidth = geometry.size.width - thumbWidth
            let fraction = (value - range.lowerBound) / (range.upperBound - range.lowerBound)
            let thumbOffset = trackWidth * fraction

            ZStack(alignment: .leading) {
                // Tick marks (behind track)
                if showTickMarks {
                    tickMarksView(trackWidth: trackWidth)
                }

                // Track
                trackView(thumbOffset: thumbOffset, trackWidth: trackWidth)

                // Thumb
                thumbView
                    .offset(x: thumbOffset)
            }
            .frame(height: thumbHeight)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { drag in
                        isDragging = true
                        let newFraction = (drag.location.x - thumbWidth / 2) / trackWidth
                        let clampedFraction = min(max(newFraction, 0), 1)
                        let rawValue = range.lowerBound + clampedFraction * (range.upperBound - range.lowerBound)
                        value = range.lowerBound + round((rawValue - range.lowerBound) / step) * step
                        value = min(max(value, range.lowerBound), range.upperBound)
                    }
                    .onEnded { _ in
                        isDragging = false
                    }
            )
        }
        .frame(height: thumbHeight)
    }

    // MARK: - Track

    private func trackView(thumbOffset: CGFloat, trackWidth: CGFloat) -> some View {
        ZStack(alignment: .leading) {
            // Unfilled track
            Capsule()
                .fill(Slate._700)
                .frame(height: trackHeight)
                .padding(.horizontal, thumbWidth / 2)

            // Filled track
            Capsule()
                .fill(VColor.accent)
                .frame(width: thumbOffset, height: trackHeight)
                .padding(.leading, thumbWidth / 2)
        }
    }

    // MARK: - Thumb

    private var thumbView: some View {
        ZStack {
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(Slate._200)
                .frame(width: thumbWidth, height: thumbHeight)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(Slate._400, lineWidth: 1)
                )
                .shadow(color: .black.opacity(0.2), radius: 2, x: 0, y: 1)

            // Grip lines
            HStack(spacing: gripLineSpacing) {
                ForEach(0..<gripLineCount, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 0.5)
                        .fill(Slate._500)
                        .frame(width: gripLineWidth, height: gripLineHeight)
                }
            }
        }
        .scaleEffect(isDragging ? 1.05 : 1.0)
        .animation(.easeOut(duration: 0.15), value: isDragging)
    }

    // MARK: - Tick Marks

    private func tickMarksView(trackWidth: CGFloat) -> some View {
        let totalSteps = Int((range.upperBound - range.lowerBound) / step)
        let maxTicks = 20
        let tickStep = totalSteps > maxTicks ? totalSteps / maxTicks : 1
        let fraction = (value - range.lowerBound) / (range.upperBound - range.lowerBound)

        return ZStack(alignment: .leading) {
            ForEach(0...totalSteps, id: \.self) { i in
                if i % tickStep == 0 {
                    let tickFraction = Double(i) / Double(totalSteps)
                    let tickX = trackWidth * tickFraction + thumbWidth / 2

                    RoundedRectangle(cornerRadius: 0.5)
                        .fill(tickFraction <= fraction ? VColor.accent.opacity(0.4) : Slate._600)
                        .frame(width: tickMarkWidth, height: tickMarkHeight)
                        .offset(x: tickX - tickMarkWidth / 2)
                }
            }
        }
    }
}

// MARK: - Preview

#Preview("VSlider") {
    @Previewable @State var value1: Double = 50
    @Previewable @State var value2: Double = 30
    @Previewable @State var value3: Double = 5

    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Default: \(Int(value1))")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                VSlider(value: $value1)
            }

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("With tick marks: \(Int(value2))")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                VSlider(value: $value2, range: 0...100, step: 5, showTickMarks: true)
            }

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Small range (1-10): \(Int(value3))")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                VSlider(value: $value3, range: 1...10, step: 1, showTickMarks: true)
            }
        }
        .padding(VSpacing.xl)
    }
    .frame(width: 400, height: 300)
}

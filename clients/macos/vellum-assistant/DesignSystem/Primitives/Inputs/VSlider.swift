import SwiftUI

struct VSlider: View {
    @Binding var value: Double
    var range: ClosedRange<Double> = 0...100
    var step: Double = 1
    var showTickMarks: Bool = false

    // MARK: - Layout Constants

    private let trackHeight: CGFloat = 24
    private let thumbWidth: CGFloat = 20
    private let tickMarkWidth: CGFloat = 1
    private let gripLineCount: Int = 3
    private let gripLineWidth: CGFloat = 1
    private let gripLineHeight: CGFloat = 12
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
                // Track
                trackView(thumbOffset: thumbOffset, trackWidth: trackWidth)

                // Tick marks (on top of unfilled track)
                if showTickMarks {
                    tickMarksView(trackWidth: trackWidth, fraction: fraction)
                }

                // Thumb
                thumbView
                    .offset(x: thumbOffset)
            }
            .frame(height: trackHeight)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { drag in
                        isDragging = true
                        let newFraction = (drag.location.x - thumbWidth / 2) / trackWidth
                        let clampedFraction = min(max(newFraction, 0), 1)
                        let rawValue = range.lowerBound + clampedFraction * (range.upperBound - range.lowerBound)
                        let snapped = round(rawValue / step) * step
                        value = min(max(snapped, range.lowerBound), range.upperBound)
                    }
                    .onEnded { _ in
                        isDragging = false
                    }
            )
        }
        .frame(height: trackHeight)
    }

    // MARK: - Track

    private func trackView(thumbOffset: CGFloat, trackWidth: CGFloat) -> some View {
        let cornerRadius: CGFloat = VRadius.md

        return ZStack(alignment: .leading) {
            // Unfilled track
            RoundedRectangle(cornerRadius: cornerRadius)
                .fill(Slate._700)
                .frame(height: trackHeight)
                .padding(.horizontal, thumbWidth / 2)

            // Filled track
            RoundedRectangle(cornerRadius: cornerRadius)
                .fill(VColor.accent)
                .frame(width: thumbOffset, height: trackHeight)
                .padding(.leading, thumbWidth / 2)
        }
    }

    // MARK: - Thumb

    private var thumbView: some View {
        ZStack {
            RoundedRectangle(cornerRadius: VRadius.xs)
                .fill(Violet._700)
                .frame(width: thumbWidth, height: trackHeight)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.xs)
                        .stroke(Violet._800, lineWidth: 1)
                )

            // Grip lines
            HStack(spacing: gripLineSpacing) {
                ForEach(0..<gripLineCount, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 0.5)
                        .fill(Violet._300)
                        .frame(width: gripLineWidth, height: gripLineHeight)
                }
            }
        }
        .scaleEffect(isDragging ? 1.05 : 1.0)
        .animation(.easeOut(duration: 0.15), value: isDragging)
    }

    // MARK: - Tick Marks

    private func tickMarksView(trackWidth: CGFloat, fraction: Double) -> some View {
        // Build tick values as multiples of step within the range
        let firstTick = ceil(range.lowerBound / step) * step
        let lastTick = floor(range.upperBound / step) * step
        let tickValues = stride(from: firstTick, through: lastTick, by: step).map { $0 }
        let maxTicks = 20
        let tickStep = tickValues.count > maxTicks ? tickValues.count / maxTicks : 1
        let rangeSpan = range.upperBound - range.lowerBound

        return ZStack(alignment: .leading) {
            ForEach(Array(tickValues.enumerated()), id: \.offset) { index, tickValue in
                if index % tickStep == 0 {
                    let tickFraction = (tickValue - range.lowerBound) / rangeSpan

                    // Only render tick marks in the unfilled portion, excluding the rightmost
                    if tickFraction > fraction && tickValue < range.upperBound {
                        let tickX = trackWidth * tickFraction + thumbWidth / 2

                        RoundedRectangle(cornerRadius: 0.5)
                            .fill(Slate._600)
                            .frame(width: tickMarkWidth, height: trackHeight)
                            .offset(x: tickX - tickMarkWidth / 2)
                    }
                }
            }
        }
    }
}

// MARK: - Preview

#if DEBUG
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
#endif

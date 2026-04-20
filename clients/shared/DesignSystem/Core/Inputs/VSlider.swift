import SwiftUI

public struct VSlider: View {
    @Binding public var value: Double
    public var range: ClosedRange<Double> = 0...100
    public var step: Double = 1
    public var showTickMarks: Bool = false

    public init(value: Binding<Double>, range: ClosedRange<Double> = 0...100, step: Double = 1, showTickMarks: Bool = false) {
        self._value = value
        self.range = range
        self.step = step
        self.showTickMarks = showTickMarks
    }

    // MARK: - Layout Constants

    private let trackHeight: CGFloat = 16
    private let thumbWidth: CGFloat = 19
    private let thumbHeight: CGFloat = 20
    private let hitAreaHeight: CGFloat = 28
    private let tickMarkWidth: CGFloat = 1
    private let gripLineCount: Int = 3
    private let gripLineWidth: CGFloat = 1
    private let gripLineHeight: CGFloat = 8
    private let gripLineSpacing: CGFloat = 2

    // MARK: - State

    @State private var isDragging = false

    // MARK: - Body

    public var body: some View {
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
            .frame(height: hitAreaHeight)
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
        .frame(height: hitAreaHeight)
    }

    // MARK: - Track

    private func trackView(thumbOffset: CGFloat, trackWidth: CGFloat) -> some View {
        ZStack(alignment: .leading) {
            // Unfilled track (edge-to-edge)
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(VColor.contentBackground)
                .frame(height: trackHeight)

            // Filled track (from left edge to thumb center)
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(VColor.contentSecondary)
                .frame(width: thumbOffset + thumbWidth / 2, height: trackHeight)
        }
        .frame(height: hitAreaHeight)
    }

    // MARK: - Thumb

    private var thumbView: some View {
        ZStack {
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(VColor.contentDefault)
                .frame(width: thumbWidth, height: thumbHeight)
                .shadow(color: VColor.auxBlack.opacity(0.1), radius: 1, x: 0, y: 1)

            // Grip lines
            HStack(spacing: gripLineSpacing) {
                ForEach(0..<gripLineCount, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 0.5)
                        .fill(VColor.contentDisabled)
                        .frame(width: gripLineWidth, height: gripLineHeight)
                }
            }
        }
        .scaleEffect(isDragging ? 1.08 : 1.0)
        .animation(VAnimation.fast, value: isDragging)
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
                            .fill(VColor.surfaceActive)
                            .frame(width: tickMarkWidth, height: trackHeight)
                            .offset(x: tickX - tickMarkWidth / 2)
                    }
                }
            }
        }
    }
}

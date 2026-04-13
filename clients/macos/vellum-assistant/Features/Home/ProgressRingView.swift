import SwiftUI
import VellumAssistantShared

/// A reusable circular progress ring that renders a gradient stroke over a
/// neutral track. The ring is decoupled from any domain model so it can be
/// composed inside relationship cards, onboarding affordances, or any other
/// home-surface module that needs a "this much of the way there" indicator.
///
/// Behavior notes:
/// - `progress` is clamped to `0...1`.
/// - At `progress == 0` the foreground stroke has zero length (no visual
///   artifacts at the start angle).
/// - At `progress == 1` the ring is rendered as a full `Circle()` rather than
///   a `trim(from: 0, to: 1)`, which avoids the hairline seam SwiftUI leaves
///   at the trim join.
/// - Value changes animate with `easeOut(duration: 0.6)`.
/// - The optional `content` view builder slots arbitrary content (e.g. an
///   avatar) in the centre of the ring, sized to the available space inside
///   the stroke.
struct ProgressRingView<Content: View>: View {
    let progress: Double
    var lineWidth: CGFloat = 8
    var trackColor: Color = VColor.surfaceLift
    var foregroundGradient: AngularGradient = ProgressRingView.defaultGradient
    @ViewBuilder var content: () -> Content

    private var clampedProgress: Double {
        min(max(progress, 0), 1)
    }

    var body: some View {
        ZStack {
            // Track
            Circle()
                .stroke(trackColor, lineWidth: lineWidth)

            // Foreground stroke
            //
            // We branch on the boundary cases so the rendered geometry is
            // a primitive `Circle` (no trim) when full and a no-op stroke
            // when empty, sidestepping SwiftUI quirks at trim extremes.
            if clampedProgress >= 1 {
                Circle()
                    .stroke(
                        foregroundGradient,
                        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))
            } else if clampedProgress > 0 {
                Circle()
                    .trim(from: 0, to: clampedProgress)
                    .stroke(
                        foregroundGradient,
                        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))
            }

            // Optional inner content (e.g. avatar). Padded by the stroke
            // width so it never overlaps the ring itself.
            content()
                .padding(lineWidth + 2)
        }
        .animation(.easeOut(duration: 0.6), value: clampedProgress)
    }

    /// Warm earthy default: a green angular sweep that reads as "growth"
    /// against the cream surface tones used elsewhere on the home page.
    static var defaultGradient: AngularGradient {
        AngularGradient(
            gradient: Gradient(colors: [
                VColor.funGreen,
                VColor.systemPositiveStrong,
                VColor.funGreen,
            ]),
            center: .center,
            startAngle: .degrees(0),
            endAngle: .degrees(360)
        )
    }
}

// MARK: - Convenience initialisers

extension ProgressRingView where Content == EmptyView {
    /// Convenience initializer for callers that just want the ring with no
    /// inner content.
    init(
        progress: Double,
        lineWidth: CGFloat = 8,
        trackColor: Color = VColor.surfaceLift,
        foregroundGradient: AngularGradient = ProgressRingView.defaultGradient
    ) {
        self.init(
            progress: progress,
            lineWidth: lineWidth,
            trackColor: trackColor,
            foregroundGradient: foregroundGradient,
            content: { EmptyView() }
        )
    }
}

// MARK: - Previews

#Preview("ProgressRingView — Light") {
    HStack(spacing: 24) {
        ProgressRingView(progress: 0.0)
            .frame(width: 96, height: 96)
        ProgressRingView(progress: 0.5)
            .frame(width: 96, height: 96)
        ProgressRingView(progress: 1.0)
            .frame(width: 96, height: 96)
    }
    .padding(32)
    .background(VColor.surfaceBase)
    .preferredColorScheme(.light)
}

#Preview("ProgressRingView — Dark") {
    HStack(spacing: 24) {
        ProgressRingView(progress: 0.0)
            .frame(width: 96, height: 96)
        ProgressRingView(progress: 0.5)
            .frame(width: 96, height: 96)
        ProgressRingView(progress: 1.0)
            .frame(width: 96, height: 96)
    }
    .padding(32)
    .background(VColor.surfaceBase)
    .preferredColorScheme(.dark)
}

#Preview("ProgressRingView — With inner content") {
    VStack(spacing: 24) {
        ProgressRingView(progress: 0.65) {
            Circle()
                .fill(VColor.funGreen.opacity(0.25))
                .overlay(
                    Text("AN")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(VColor.contentEmphasized)
                )
        }
        .frame(width: 120, height: 120)
    }
    .padding(32)
    .background(VColor.surfaceBase)
}

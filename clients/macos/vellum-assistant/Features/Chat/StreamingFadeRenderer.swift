import SwiftUI

/// Per-glyph opacity fade-in renderer for streaming text.
///
/// Run slices below `elapsedCount` render at full opacity; slices at
/// the boundary transition from 0 → 1 as SwiftUI interpolates the
/// animatable data between flush updates. Slices beyond the boundary
/// are invisible (mid-animation, not yet reached).
///
/// Apply with `.animation(.easeIn(duration: 0.15), value: characterCount)`
/// so SwiftUI interpolates `elapsedCount` from the previous character count
/// to the new one, producing a smooth fade-in for each streaming delta.
///
/// References:
/// - https://developer.apple.com/documentation/swiftui/textrenderer
/// - WWDC 2024: "Create custom visual effects with SwiftUI"
struct StreamingFadeRenderer: TextRenderer {
    /// The number of run slices that should be fully visible.
    /// SwiftUI animates this value between updates.
    var elapsedCount: Double

    var animatableData: Double {
        get { elapsedCount }
        set { elapsedCount = newValue }
    }

    func draw(layout: Text.Layout, in ctx: inout GraphicsContext) {
        for (index, slice) in layout.flattenedRunSlices.enumerated() {
            let progress = min(1, max(0, elapsedCount - Double(index)))
            if progress >= 1 {
                ctx.draw(slice)
            } else if progress > 0 {
                var copy = ctx
                copy.opacity = progress
                copy.draw(slice)
            }
        }
    }
}

// MARK: - Text.Layout Flattening (Apple WWDC 2024 sample code pattern)

extension Text.Layout {
    var flattenedRuns: some RandomAccessCollection<Text.Layout.Run> {
        flatMap { line in line }
    }

    var flattenedRunSlices: some RandomAccessCollection<Text.Layout.RunSlice> {
        flattenedRuns.flatMap(\.self)
    }
}

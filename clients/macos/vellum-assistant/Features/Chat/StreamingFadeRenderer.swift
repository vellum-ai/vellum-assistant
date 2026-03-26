import SwiftUI

/// Per-glyph renderer for streaming text.
///
/// With the typewriter drip at the data layer, characters arrive a few
/// at a time. This renderer simply draws all laid-out run slices.
/// The `elapsedCount` / `animatableData` conformance is retained so
/// SwiftUI can still drive layout animations when character count changes.
///
/// References:
/// - https://developer.apple.com/documentation/swiftui/textrenderer
/// - WWDC 2024: "Create custom visual effects with SwiftUI"
struct StreamingFadeRenderer: TextRenderer {
    var elapsedCount: Double

    var animatableData: Double {
        get { elapsedCount }
        set { elapsedCount = newValue }
    }

    func draw(layout: Text.Layout, in ctx: inout GraphicsContext) {
        for line in layout {
            for run in line {
                ctx.draw(run)
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

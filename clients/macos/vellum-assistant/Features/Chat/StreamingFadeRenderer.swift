import SwiftUI

/// Per-glyph opacity fade-in renderer for streaming text.
///
/// Characters below `elapsedCount` render at full opacity; characters at
/// the boundary transition from 0 → 1 as SwiftUI interpolates the
/// animatable data between flush updates. Characters beyond the boundary
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
    /// The number of glyphs that should be fully visible.
    /// SwiftUI animates this value between updates.
    var elapsedCount: Double

    var animatableData: Double {
        get { elapsedCount }
        set { elapsedCount = newValue }
    }

    func draw(layout: Text.Layout, in ctx: inout GraphicsContext) {
        var glyphIndex = 0
        for line in layout {
            for run in line {
                for glyph in run {
                    let progress = min(1, max(0, elapsedCount - Double(glyphIndex)))
                    if progress >= 1 {
                        // Fully visible — draw without context copy for performance.
                        ctx.draw(glyph)
                    } else if progress > 0 {
                        // Partially visible — fade in.
                        var glyphCtx = ctx
                        glyphCtx.opacity = progress
                        glyphCtx.draw(glyph)
                    }
                    // progress <= 0: glyph not yet visible during animation.
                    glyphIndex += 1
                }
            }
        }
    }
}

import SwiftUI
import VellumAssistantShared

/// Namespace for shared home recap card constants.
enum RecapCard {
    /// Maximum width for any home recap card. Cards naturally hug their
    /// content; apply `.recapCardMaxWidth()` if a card or its container
    /// should cap expansion at this value.
    static let maxWidth: CGFloat = 528
}

/// Frosted-glass card recipe for floating notification cards and pills.
///
/// Approximates the Figma "Glass" effect (a native shader) using the
/// SwiftUI primitives that exist:
///   - `.ultraThinMaterial`         — backdrop blur (Figma Frost ≈ 14)
///   - `VColor.glassFill`           — 10% white tint over the blur
///   - `AngularGradient` stroke     — aspect-ratio-aware edge highlight
///                                    (approximates Figma Light = -45° @ 80%)
///   - single `.shadow(...)`        — Figma drop shadow 0/4/12 black 5%
///
/// Both modes render the same dual-corner pattern: uniform bright stroke
/// along the whole border with narrow clear "dips" at BL and TR, plus
/// thicker 1pt highlights at TL and BR. The Figma spec differentiates
/// light (single-corner) from dark (dual-corner), but in SwiftUI the
/// single-corner pattern gets visually overwhelmed by Material's own
/// neutral rim — so we unify on dual-corner for a consistent white rim
/// in both modes. Token alpha (80%) keeps the rim slightly translucent
/// to read as reflected glass rather than a hard painted line.
///
/// Using an `AngularGradient` sweeping by angle from the card's center
/// (rather than a diagonal `LinearGradient`) is critical: corner
/// positions in the gradient are computed from `atan2(height, width)`,
/// so the bright/clear regions land on the correct geometric corners
/// regardless of aspect ratio. A `GeometryReader` reads the card's size
/// once per layout pass (effectively free — `atan2` and gradient stop
/// construction are nanosecond-scale, gradient rendering is GPU-composited
/// like any other gradient).
///
/// Refraction, dispersion, and depth themselves cannot be replicated
/// without a Metal shader and are deliberately omitted.
///
/// Generic over `InsettableShape` so the same recipe drops into both
/// rounded-rectangle cards and pill-shaped surfaces.
private struct GlassCardModifier<S: InsettableShape>: ViewModifier {
    let shape: S
    let padding: CGFloat

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(
                ZStack {
                    shape.fill(.ultraThinMaterial)
                    shape.fill(VColor.glassFill)
                }
            )
            .overlay(
                GeometryReader { proxy in
                    ZStack {
                        // Thin (0.5pt) stroke carries the full edge
                        // highlight pattern along the whole border.
                        shape.strokeBorder(edgeHighlight(size: proxy.size), lineWidth: 0.5)
                        // Concentric 1pt stroke only paints at the corner
                        // highlights (TL in light mode, TL + BR in dark),
                        // clear elsewhere. Where it paints, the corner
                        // reads as a full 1pt line; everywhere else only
                        // the thin 0.5pt stroke shows through.
                        shape.strokeBorder(cornerHighlight(size: proxy.size), lineWidth: 1)
                    }
                }
            )
            .clipShape(shape)
            .shadow(color: VColor.glassDropShadow, radius: 6, x: 0, y: 4)
    }

    /// Aspect-ratio-aware angular gradient for the edge-highlight stroke.
    ///
    /// The four corners sit at normalized angles derived from `atan2(h, w)`:
    ///   BR ≈ f, BL ≈ 0.5 - f, TL ≈ 0.5 + f, TR ≈ 1 - f
    /// where `f = atan2(h, w) / (2π)` expresses the corner angle as a
    /// fraction of the full circle. Using the actual corner angles instead
    /// of axis-projected locations keeps the bright/clear regions aligned
    /// to the real geometric corners regardless of the card's shape.
    private func edgeHighlight(size: CGSize) -> AngularGradient {
        let w = max(size.width, 1)
        let h = max(size.height, 1)
        let f = atan2(h, w) / (2 * .pi)
        let bright = VColor.glassEdgeHighlight
        let dip: CGFloat = 0.02

        // Dual-corner: bright plateau covers all four edges, narrow clear
        // dips land exactly at BL and TR.
        let stops: [Gradient.Stop] = [
            .init(color: bright, location: 0),
            .init(color: bright, location: 0.5 - f - dip),
            .init(color: .clear, location: 0.5 - f),
            .init(color: bright, location: 0.5 - f + dip),
            .init(color: bright, location: 1 - f - dip),
            .init(color: .clear, location: 1 - f),
            .init(color: bright, location: 1 - f + dip),
            .init(color: bright, location: 1),
        ]

        return AngularGradient(stops: stops, center: .center)
    }

    /// Angular gradient for the thick corner stroke — bright only in a
    /// narrow plateau at each corner-highlight position, clear elsewhere.
    /// Layered on top of the thin edge stroke, this gives the bright
    /// corners a heavier 1pt stroke while leaving the rest of the border
    /// at the thinner 0.5pt weight.
    private func cornerHighlight(size: CGSize) -> AngularGradient {
        let w = max(size.width, 1)
        let h = max(size.height, 1)
        let f = atan2(h, w) / (2 * .pi)
        let half: CGFloat = 0.015   // plateau half-width (~5° of arc)
        let bright = VColor.glassEdgeHighlight
        let tl = 0.5 + f

        // Two plateaus: BR (near location f) and TL (near 0.5 + f).
        let stops: [Gradient.Stop] = [
            .init(color: .clear, location: 0),
            .init(color: .clear, location: f - half),
            .init(color: bright, location: f),
            .init(color: .clear, location: f + half),
            .init(color: .clear, location: tl - half),
            .init(color: bright, location: tl),
            .init(color: .clear, location: tl + half),
            .init(color: .clear, location: 1),
        ]

        return AngularGradient(stops: stops, center: .center)
    }
}

extension View {
    /// Apply the standard glass card recipe with a custom shape.
    /// Used by all home recap cards and pills for a consistent floating-glass
    /// aesthetic. The card naturally hugs its content; combine with
    /// `.recapCardMaxWidth()` if a width cap is desired.
    func glassCard<S: InsettableShape>(
        shape: S,
        padding: CGFloat = VSpacing.sm
    ) -> some View {
        modifier(GlassCardModifier(shape: shape, padding: padding))
    }

    /// Apply the standard glass card recipe with a rounded rectangle shape
    /// (default `VRadius.xl`, continuous style). The card naturally hugs its
    /// content; combine with `.recapCardMaxWidth()` if a width cap is desired.
    func glassCard(
        cornerRadius: CGFloat = VRadius.xl,
        padding: CGFloat = VSpacing.sm
    ) -> some View {
        glassCard(
            shape: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous),
            padding: padding
        )
    }

    /// Apply the standard recap card width behavior.
    ///
    /// - Parameter fill: When `true`, the card always fills the available
    ///   width up to `RecapCard.maxWidth` (528pt) — useful for detailed
    ///   cards (HomeReplyCard, HomeEmailPreviewCard, HomeImageCard,
    ///   HomeFileCard) that should appear as fixed-width surfaces.
    ///   When `false` (default), the card hugs its intrinsic content
    ///   width up to the cap — useful for compact cards (HomeAuthCard
    ///   simple, HomeAssistantCard) that should stay compact for short
    ///   content but never overflow.
    @ViewBuilder
    func recapCardMaxWidth(fill: Bool = false) -> some View {
        if fill {
            frame(maxWidth: RecapCard.maxWidth, alignment: .leading)
        } else {
            frame(maxWidth: RecapCard.maxWidth, alignment: .leading)
                .fixedSize(horizontal: true, vertical: false)
        }
    }
}

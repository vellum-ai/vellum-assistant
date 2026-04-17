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
///   - gradient strokeBorder        — edge highlight from upper-left
///                                    (Figma Light = -45° @ 80%)
///   - single `.shadow(...)`        — Figma drop shadow 0/4/12 black 5%
///
/// In dark mode a second highlight is painted on the lower-right edge to
/// approximate the Glass effect's refraction (Refraction=80) lensing the
/// upper-left light catch through to the opposite corner. Refraction,
/// dispersion, and depth themselves cannot be replicated without a Metal
/// shader and are deliberately omitted.
///
/// Generic over `InsettableShape` so the same recipe drops into both
/// rounded-rectangle cards and pill-shaped surfaces.
private struct GlassCardModifier<S: InsettableShape>: ViewModifier {
    let shape: S
    let padding: CGFloat

    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(
                ZStack {
                    shape.fill(.ultraThinMaterial)
                    shape.fill(VColor.glassFill)
                }
            )
            .overlay(shape.strokeBorder(edgeHighlight, lineWidth: 1))
            .clipShape(shape)
            .shadow(color: VColor.glassDropShadow, radius: 6, x: 0, y: 4)
    }

    /// Linear gradient applied to the edge stroke.
    /// Light mode: bright at top-leading, fading to clear toward bottom-trailing.
    /// Dark mode: bright at both top-leading and bottom-trailing, clear in the
    /// middle — fakes the refraction "exit" highlight on the opposite corner.
    private var edgeHighlight: LinearGradient {
        let stops: [Gradient.Stop] = colorScheme == .dark
            ? [
                .init(color: VColor.glassEdgeHighlight, location: 0),
                .init(color: .clear, location: 0.5),
                .init(color: VColor.glassEdgeHighlight, location: 1),
            ]
            : [
                .init(color: VColor.glassEdgeHighlight, location: 0),
                .init(color: .clear, location: 1),
            ]
        return LinearGradient(
            stops: stops,
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
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

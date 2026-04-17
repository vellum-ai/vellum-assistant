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
/// Composes a real backdrop blur (`.ultraThinMaterial`) with a brand-correct
/// adaptive tint (`VColor.glassFill`), a faint adaptive stroke
/// (`VColor.glassStroke`), and a layered dual shadow (`glassShadowNear` +
/// `glassShadowFar`). Generic over `InsettableShape` so the same recipe
/// drops into both rounded-rectangle cards and pill-shaped surfaces.
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
            .overlay(shape.strokeBorder(VColor.glassStroke, lineWidth: 1))
            .clipShape(shape)
            .shadow(color: VColor.glassShadowNear, radius: 1.5, x: 0, y: 1)
            .shadow(color: VColor.glassShadowFar, radius: 12, x: 0, y: 8)
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

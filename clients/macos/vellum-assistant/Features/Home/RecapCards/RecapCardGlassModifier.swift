import SwiftUI
import VellumAssistantShared

/// Namespace for shared home recap card constants.
enum RecapCard {
    /// Maximum width for any home recap card. Cards naturally hug their
    /// content; apply `.recapCardMaxWidth()` if a card or its container
    /// should cap expansion at this value.
    static let maxWidth: CGFloat = 528
}

/// Synthetic glassmorphism for home recap cards.
/// Adaptive across light/dark, context-independent (does not rely on
/// backdrop blur, so it renders consistently regardless of what's behind it).
///
/// - Fill: vertical gradient from contentEmphasized 6% → 2%
/// - Stroke: vertical gradient from contentEmphasized 18% → 6%
/// - Shadow: black 8% opacity, radius 16, y: 6
///
/// Cards naturally hug their content. To cap width, use `.recapCardMaxWidth()`
/// either inside the card's body or at the container level.
///
/// Uses `contentEmphasized` (near-black light, near-white dark) so the
/// gradient reads as glass refraction in both modes.
private struct RecapCardGlassModifier<S: InsettableShape>: ViewModifier {
    let shape: S
    let padding: CGFloat

    private var glassFill: LinearGradient {
        LinearGradient(
            colors: [
                VColor.contentEmphasized.opacity(0.06),
                VColor.contentEmphasized.opacity(0.02),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    private var glassStroke: LinearGradient {
        LinearGradient(
            colors: [
                VColor.contentEmphasized.opacity(0.18),
                VColor.contentEmphasized.opacity(0.06),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(shape.fill(glassFill))
            .overlay(shape.strokeBorder(glassStroke, lineWidth: 1))
            .clipShape(shape)
            .shadow(color: VColor.auxBlack.opacity(0.08), radius: 16, x: 0, y: 6)
    }
}

extension View {
    /// Apply the standard recap card glassmorphism with a custom shape.
    /// Used by all home recap cards (HomeAuthCard, HomePermissionCard, etc.)
    /// for consistent visual treatment. The card naturally hugs its
    /// content; combine with `.recapCardMaxWidth()` if a width cap is desired.
    func recapCardGlass<S: InsettableShape>(
        shape: S,
        padding: CGFloat = VSpacing.sm
    ) -> some View {
        modifier(RecapCardGlassModifier(shape: shape, padding: padding))
    }

    /// Apply the standard recap card glassmorphism with a rounded rectangle
    /// shape (default `VRadius.xl`, continuous style). The card naturally hugs
    /// its content; combine with `.recapCardMaxWidth()` if a width cap is desired.
    func recapCardGlass(
        cornerRadius: CGFloat = VRadius.xl,
        padding: CGFloat = VSpacing.sm
    ) -> some View {
        recapCardGlass(
            shape: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous),
            padding: padding
        )
    }

    /// Hug content but cap at `RecapCard.maxWidth` (528pt).
    /// - When intrinsic content width is less than the cap, the view sizes
    ///   to its content (compact cards stay compact).
    /// - When intrinsic content would exceed the cap (e.g., a very long title
    ///   or a child requesting `.frame(maxWidth: .infinity)`), the view caps
    ///   at 528pt and content wraps/clips inside.
    ///
    /// The combination of `.frame(maxWidth:)` and `.fixedSize(horizontal:)`
    /// is the canonical SwiftUI idiom for "intrinsic-or-bounded" sizing.
    func recapCardMaxWidth() -> some View {
        frame(maxWidth: RecapCard.maxWidth, alignment: .leading)
            .fixedSize(horizontal: true, vertical: false)
    }
}

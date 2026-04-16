import SwiftUI
import VellumAssistantShared

/// Maximum width for any home recap card. Cards expand to fill
/// available width up to this cap, then stop growing.
let recapCardMaxWidth: CGFloat = 528

/// Synthetic glassmorphism for home recap cards.
/// Adaptive across light/dark, context-independent (does not rely on
/// backdrop blur, so it renders consistently regardless of what's behind it).
///
/// - Width: capped at `recapCardMaxWidth` (528pt)
/// - Fill: vertical gradient from contentEmphasized 6% → 2%
/// - Stroke: vertical gradient from contentEmphasized 18% → 6%
/// - Shadow: black 8% opacity, radius 16, y: 6
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
            .frame(maxWidth: recapCardMaxWidth, alignment: .leading)
            .background(shape.fill(glassFill))
            .overlay(shape.strokeBorder(glassStroke, lineWidth: 1))
            .clipShape(shape)
            .shadow(color: VColor.auxBlack.opacity(0.08), radius: 16, x: 0, y: 6)
    }
}

extension View {
    /// Apply the standard recap card glassmorphism with a custom shape.
    /// Used by all home recap cards (HomeAuthCard, HomePermissionCard, etc.)
    /// for consistent visual treatment. Cards are capped at
    /// `recapCardMaxWidth` (528pt).
    func recapCardGlass<S: InsettableShape>(
        shape: S,
        padding: CGFloat = VSpacing.sm
    ) -> some View {
        modifier(RecapCardGlassModifier(shape: shape, padding: padding))
    }

    /// Apply the standard recap card glassmorphism with a rounded rectangle
    /// shape (default `VRadius.xl`, continuous style). Cards are capped at
    /// `recapCardMaxWidth` (528pt).
    func recapCardGlass(
        cornerRadius: CGFloat = VRadius.xl,
        padding: CGFloat = VSpacing.sm
    ) -> some View {
        recapCardGlass(
            shape: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous),
            padding: padding
        )
    }
}

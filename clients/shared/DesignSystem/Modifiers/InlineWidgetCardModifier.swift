import SwiftUI

/// Standard card chrome for inline chat widgets.
/// Applies consistent padding, background, border, corner radius, and shadow
/// so all widget types (card, dynamic page, table, list) share the same visual treatment.
public struct InlineWidgetCardModifier: ViewModifier {
    public func body(content: Content) -> some View {
        content
            .padding(VSpacing.lg)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(VColor.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(VColor.surfaceBorder.opacity(0.4), lineWidth: 1)
            )
            .vShadow(VShadow.sm)
    }
}

public extension View {
    func inlineWidgetCard() -> some View {
        modifier(InlineWidgetCardModifier())
    }
}

#if DEBUG
#Preview("InlineWidgetCard") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: VSpacing.lg) {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Widget Title")
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)
                Text("Some body content for the widget card.")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
            }
            .inlineWidgetCard()

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Another Widget")
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)
                Text("Both cards share the same chrome.")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
            }
            .inlineWidgetCard()
        }
        .padding()
    }
    .frame(width: 450, height: 300)
}
#endif

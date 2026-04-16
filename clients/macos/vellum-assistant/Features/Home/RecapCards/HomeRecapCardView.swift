import SwiftUI
import VellumAssistantShared

/// Container view for recap cards on the Home page. Provides a
/// glassmorphic rounded surface with shadow that wraps arbitrary
/// card content via a `@ViewBuilder` slot.
struct HomeRecapCardView<Content: View>: View {
    private let content: Content

    init(
        @ViewBuilder content: () -> Content
    ) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(VSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous)
                    .fill(VColor.surfaceLift.opacity(0.1))
            )
            .clipShape(RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous))
            .vShadow(VShadow.md)
    }
}

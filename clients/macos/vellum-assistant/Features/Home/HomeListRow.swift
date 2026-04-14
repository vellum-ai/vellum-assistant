import SwiftUI
import VellumAssistantShared

/// Shared visual chrome for every row in the redesigned Home page list
/// sections. A single rounded surface with a hairline border so every
/// row — feed item, capability, or anything we add later — reads as the
/// same "Home row" primitive.
///
/// Consumers own their own inner layout; this wrapper only owns the
/// padding + background + stroke so we have one place to re-tune the
/// chrome when the design evolves.
struct HomeListRow<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: VRadius.window, style: .continuous)
                    .fill(VColor.surfaceLift)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.window, style: .continuous)
                    .stroke(VColor.borderBase, lineWidth: 1)
            )
    }
}

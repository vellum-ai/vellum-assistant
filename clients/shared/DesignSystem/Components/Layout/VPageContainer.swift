import SwiftUI

/// Standard page container for full-width panel pages (Intelligence, Library, Usage, Logs).
/// Provides a consistent title + child content layout with shared spacing.
public struct VPageContainer<Content: View>: View {
    public let title: String
    @ViewBuilder public let content: () -> Content

    public init(title: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.content = content
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .font(VFont.titleLarge)
                .foregroundStyle(VColor.contentEmphasized)
                .padding(.bottom, VSpacing.lg)

            content()
        }
        .padding(VSpacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
    }
}

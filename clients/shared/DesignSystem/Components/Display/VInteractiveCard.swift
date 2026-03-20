import SwiftUI

/// A tappable card with hover feedback, border, and pointer cursor.
/// Encapsulates the common interactive card pattern: bordered container
/// that highlights on hover and navigates on tap.
public struct VInteractiveCard<Content: View>: View {
    public let action: () -> Void
    @ViewBuilder public let content: () -> Content
    @State private var isHovered = false

    public init(
        action: @escaping () -> Void,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.action = action
        self.content = content
    }

    public var body: some View {
        Button(action: action) {
            content()
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(isHovered ? VColor.surfaceActive : Color.clear)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.xl)
                        .stroke(VColor.borderDisabled, lineWidth: 2)
                )
                .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .onHover { isHovered = $0 }
    }
}

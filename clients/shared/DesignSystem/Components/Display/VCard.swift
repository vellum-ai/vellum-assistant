import SwiftUI

public struct VCard<Content: View>: View {
    public var padding: CGFloat = VSpacing.lg
    public var isActive: Bool = false
    public var action: (() -> Void)?
    @ViewBuilder public let content: () -> Content

    @State private var isHovered = false

    public init(
        padding: CGFloat = VSpacing.lg,
        isActive: Bool = false,
        action: (() -> Void)? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.padding = padding
        self.isActive = isActive
        self.action = action
        self.content = content
    }

    private var backgroundColor: Color {
        if isActive { return VColor.surfaceActive }
        if isHovered && action != nil { return VColor.surfaceBase }
        return VColor.surfaceOverlay
    }

    public var body: some View {
        content()
            .padding(padding)
            .background(backgroundColor)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.xl)
                    .strokeBorder(VColor.borderDisabled, lineWidth: 2)
            )
            .contentShape(RoundedRectangle(cornerRadius: VRadius.xl))
            .onHover { isHovered = $0 }
            .animation(VAnimation.fast, value: isHovered)
            .if(action != nil) { view in
                view
                    .onTapGesture { action?() }
                    .pointerCursor()
            }
    }
}

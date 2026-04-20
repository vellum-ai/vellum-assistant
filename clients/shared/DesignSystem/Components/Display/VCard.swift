import SwiftUI

public struct VCard<Content: View>: View {
    public var padding: CGFloat = VSpacing.lg
    public var isActive: Bool = false
    public var action: (() -> Void)?
    public var background: Color?
    @ViewBuilder public let content: () -> Content

    @State private var isHovered = false

    public init(
        padding: CGFloat = VSpacing.lg,
        isActive: Bool = false,
        action: (() -> Void)? = nil,
        background: Color? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.padding = padding
        self.isActive = isActive
        self.action = action
        self.background = background
        self.content = content
    }

    private var backgroundColor: Color {
        if let background { return background }
        if isActive { return VColor.surfaceActive }
        if isHovered && action != nil { return VColor.surfaceBase }
        return VColor.surfaceLift
    }

    public var body: some View {
        content()
            .padding(padding)
            .background(backgroundColor)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.xl)
                    .strokeBorder(VColor.borderHover, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: VRadius.xl))
            .onTapGesture { action?() }
            .pointerCursor(enabled: action != nil, onHover: { isHovered = $0 })
            .animation(VAnimation.fast, value: isHovered)
    }
}

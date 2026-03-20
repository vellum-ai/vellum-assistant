import SwiftUI

public struct VListRow<Content: View>: View {
    public var onTap: (() -> Void)? = nil
    @ViewBuilder public let content: () -> Content

    @State private var isHovered = false

    public init(onTap: (() -> Void)? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.onTap = onTap
        self.content = content
    }

    public var body: some View {
        Group {
            if let onTap = onTap {
                Button(action: onTap) {
                    rowContent
                }
                .buttonStyle(.plain)
                .vPointerCursor()
            } else {
                rowContent
            }
        }
    }

    private var rowContent: some View {
        content()
            .padding(.vertical, VSpacing.sm)
            .padding(.horizontal, VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(VColor.surfaceBase.opacity(isHovered ? 1 : 0))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            .onHover { hovering in
                isHovered = hovering
            }
    }
}


import SwiftUI

struct VListRow<Content: View>: View {
    var onTap: (() -> Void)? = nil
    @ViewBuilder let content: () -> Content

    @State private var isHovered = false

    var body: some View {
        Group {
            if let onTap = onTap {
                Button(action: onTap) {
                    rowContent
                }
                .buttonStyle(.plain)
            } else {
                rowContent
            }
        }
    }

    private var rowContent: some View {
        content()
            .padding(.vertical, VSpacing.md)
            .padding(.horizontal, VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isHovered ? VColor.surfaceBorder.opacity(0.5) : .clear)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            .onHover { hovering in
                isHovered = hovering
            }
    }
}

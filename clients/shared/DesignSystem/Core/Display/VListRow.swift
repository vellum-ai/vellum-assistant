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
                .pointerCursor()
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
            .background(isHovered ? VColor.navHover : .clear)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            .onHover { hovering in
                isHovered = hovering
            }
    }
}

#Preview("VListRow") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: 0) {
            VListRow(onTap: {}) {
                HStack {
                    VIconView(.fileText, size: 14)
                        .foregroundColor(VColor.accent)
                    Text("Tappable row")
                        .foregroundColor(VColor.textPrimary)
                }
            }
            Divider()
            VListRow {
                Text("Static row")
                    .foregroundColor(VColor.textSecondary)
            }
        }
        .padding()
    }
    .frame(width: 300, height: 150)
}

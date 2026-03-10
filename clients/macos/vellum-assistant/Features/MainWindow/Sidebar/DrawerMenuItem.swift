import AppKit
import SwiftUI
import VellumAssistantShared

struct DrawerMenuItem: View {
    let icon: String
    let label: String
    var description: String? = nil
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: VSpacing.xs) {
                    VIconView(SFSymbolMapping.icon(forSFSymbol: icon, fallback: .puzzle), size: 12)
                        .foregroundColor(isHovered ? VColor.textPrimary : VColor.textSecondary)
                        .frame(width: 18)
                        .rotationEffect(.degrees(isHovered ? -10 : 0))
                        .scaleEffect(isHovered ? 1.15 : 1.0)
                        .animation(VAnimation.fast, value: isHovered)
                    Text(label)
                        .font(.custom("Inter", size: 13))
                        .foregroundColor(VColor.textPrimary)
                    Spacer()
                }
                if let description {
                    Text(description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .background(VColor.navHover.opacity(isHovered ? 1 : 0))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHovered = hovering
        }
        .pointerCursor()
    }
}

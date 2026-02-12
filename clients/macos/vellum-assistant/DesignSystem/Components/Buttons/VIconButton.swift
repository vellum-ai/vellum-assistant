import SwiftUI

struct VIconButton: View {
    let label: String
    let icon: String          // SF Symbol name
    var isActive: Bool = false
    var iconOnly: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: VSpacing.xs) {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .medium))
                if !iconOnly {
                    Text(label)
                        .font(VFont.caption)
                }
            }
            .foregroundColor(isActive ? VColor.textPrimary : VColor.textSecondary)
            .padding(.horizontal, iconOnly ? VSpacing.md : VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .background(isActive ? VColor.surfaceBorder : .clear)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(isActive ? VColor.textSecondary : VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            NSCursor.pointingHand.set()
            if !hovering { NSCursor.arrow.set() }
        }
        .accessibilityLabel(label)
    }
}

#Preview("VIconButton") {
    ZStack {
        VColor.background.ignoresSafeArea()
        HStack(spacing: 12) {
            VIconButton(label: "Settings", icon: "gear") {}
            VIconButton(label: "Active", icon: "star.fill", isActive: true) {}
            VIconButton(label: "Icon Only", icon: "plus", iconOnly: true) {}
            VIconButton(label: "Active Icon", icon: "pencil", isActive: true, iconOnly: true) {}
        }
        .padding()
    }
    .frame(width: 400, height: 80)
}

import SwiftUI

public struct DemoOverlayView: View {
    @State private var isHovered = false

    public init() {}

    public var body: some View {
        if FeatureFlagManager.shared.isEnabled(.demo) {
            HStack(spacing: VSpacing.sm) {
                Circle()
                    .fill(Emerald._500)
                    .frame(width: 8, height: 8)
                Text("Demo Mode")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(VColor.textPrimary)
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.xs)
            .background(VColor.surface.opacity(isHovered ? 1 : 0.85))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.surfaceBorder, lineWidth: 1)
            )
            .vShadow(VShadow.sm)
            .onHover { hovering in
                withAnimation(VAnimation.fast) {
                    isHovered = hovering
                }
            }
            .padding(VSpacing.md)
        }
    }
}

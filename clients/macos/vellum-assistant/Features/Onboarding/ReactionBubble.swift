import VellumAssistantShared
import SwiftUI

struct ReactionBubble: View {
    let text: String
    var delay: TimeInterval = 0.4

    @State private var visible = false

    var body: some View {
        Text(text)
            .font(VFont.body)
            .foregroundColor(VColor.contentDefault.opacity(0.9))
            .padding(.horizontal, VSpacing.xl)
            .padding(.vertical, VSpacing.md + VSpacing.xxs)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(VColor.surfaceBase.opacity(0.5))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.borderBase.opacity(0.4), lineWidth: 1)
                    )
            )
            .opacity(visible ? 1 : 0)
            .offset(y: visible ? 0 : 8)
            .onAppear {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    withAnimation(.easeOut(duration: 0.5)) {
                        visible = true
                    }
                }
            }
    }
}

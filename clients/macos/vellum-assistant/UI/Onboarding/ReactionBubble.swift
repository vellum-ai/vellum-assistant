import SwiftUI

struct ReactionBubble: View {
    let text: String
    var delay: TimeInterval = 0.4

    @State private var visible = false

    var body: some View {
        Text(text)
            .font(VellumFont.body)
            .foregroundColor(VellumTheme.textPrimary.opacity(0.9))
            .padding(.horizontal, VellumSpacing.xl)
            .padding(.vertical, VellumSpacing.md + VellumSpacing.xxs)
            .background(
                RoundedRectangle(cornerRadius: VellumRadius.lg)
                    .fill(VellumTheme.surface.opacity(0.5))
                    .overlay(
                        RoundedRectangle(cornerRadius: VellumRadius.lg)
                            .stroke(VellumTheme.surfaceBorder.opacity(0.4), lineWidth: 1)
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

#Preview {
    ZStack {
        VellumTheme.background
        ReactionBubble(text: "Nice to meet you!")
    }
    .frame(width: 400, height: 200)
}

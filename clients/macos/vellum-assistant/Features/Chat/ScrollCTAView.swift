import SwiftUI
import VellumAssistantShared

/// "There's a lot more I can do" scroll prompt with a bouncing chevron.
/// Fades in ~1 second after appearing.
struct ScrollCTAView: View {
    let onTap: () -> Void

    @State private var visible = false
    @State private var bouncing = false

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: VSpacing.sm) {
                Text("There\u{2019}s a lot more I can do")
                    .font(.custom("Fraunces", size: 14).italic())
                    .foregroundColor(VColor.contentTertiary)

                VIcon.chevronDown.image
                    .resizable()
                    .frame(width: 14, height: 14)
                    .foregroundColor(VColor.contentTertiary)
                    .offset(y: bouncing ? 4 : 0)
                    .animation(
                        .easeInOut(duration: 1.0).repeatForever(autoreverses: true),
                        value: bouncing
                    )
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(visible ? 1 : 0)
        .padding(.vertical, VSpacing.xxl)
        .onAppear {
            // Delay fade-in so the hero section breathes
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                withAnimation(.easeOut(duration: 0.5)) {
                    visible = true
                }
                bouncing = true
            }
        }
    }
}

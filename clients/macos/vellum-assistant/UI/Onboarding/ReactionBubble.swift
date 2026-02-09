import SwiftUI

struct ReactionBubble: View {
    let text: String
    var delay: TimeInterval = 0.4

    @State private var visible = false

    var body: some View {
        Text(text)
            .font(.system(size: 15))
            .foregroundColor(.white.opacity(0.9))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 16)
                    .fill(Color.white.opacity(0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16)
                            .stroke(Color.white.opacity(0.12), lineWidth: 1)
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
        Color(hex: 0x0E0E11)
        ReactionBubble(text: "Nice to meet you!")
    }
    .frame(width: 400, height: 200)
}

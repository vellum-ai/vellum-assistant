import SwiftUI

/// The revealed creature (purple dino) with spring entrance and breathing animation.
struct CreatureView: View {
    let visible: Bool

    @State private var appeared = false
    @State private var bounceOffset: CGFloat = 0
    @State private var breatheScaleY: CGFloat = 1.0
    @State private var breatheScaleX: CGFloat = 1.0

    var body: some View {
        if visible {
            dinoImage
                .scaleEffect(x: breatheScaleX, y: breatheScaleY, anchor: .bottom)
                .offset(y: bounceOffset)
                .scaleEffect(appeared ? 1.0 : 0.0)
                .opacity(appeared ? 1.0 : 0.0)
                .onAppear {
                    // Spring entrance
                    withAnimation(.spring(response: 0.6, dampingFraction: 0.5, blendDuration: 0)) {
                        appeared = true
                    }
                    // Bounce
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        withAnimation(.easeOut(duration: 0.6)) {
                            bounceOffset = -15
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                            withAnimation(.easeIn(duration: 0.3)) {
                                bounceOffset = 0
                            }
                        }
                    }
                    // Breathing idle (after 1s delay)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                        withAnimation(.easeInOut(duration: 3).repeatForever(autoreverses: true)) {
                            breatheScaleY = 1.03
                            breatheScaleX = 0.98
                        }
                    }
                }
        }
    }

    @ViewBuilder
    private var dinoImage: some View {
        if let url = Bundle.module.url(forResource: "dino", withExtension: "webp"),
           let nsImage = NSImage(contentsOf: url) {
            Image(nsImage: nsImage)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 400, height: 360)
                .shadow(radius: 8)
        } else {
            // Fallback
            Text("🦕")
                .font(.system(size: 120))
        }
    }
}

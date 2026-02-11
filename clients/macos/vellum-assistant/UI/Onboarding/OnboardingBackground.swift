import SwiftUI

struct OnboardingBackground: View {
    @State private var offset1: CGFloat = 0
    @State private var offset2: CGFloat = 0
    @State private var offset3: CGFloat = 0

    var body: some View {
        ZStack {
            VellumTheme.background

            // Ambient gradient orb 1 — top-left, warm
            Circle()
                .fill(
                    RadialGradient(
                        gradient: Gradient(colors: [
                            VellumTheme.onboardingAccent.opacity(0.08),
                            Color.clear,
                        ]),
                        center: .center,
                        startRadius: 0,
                        endRadius: 200
                    )
                )
                .frame(width: 400, height: 400)
                .offset(x: -120 + offset1 * 10, y: -100 + offset1 * 6)

            // Ambient gradient orb 2 — bottom-right, cool
            Circle()
                .fill(
                    RadialGradient(
                        gradient: Gradient(colors: [
                            Indigo._700.opacity(0.06),
                            Color.clear,
                        ]),
                        center: .center,
                        startRadius: 0,
                        endRadius: 180
                    )
                )
                .frame(width: 360, height: 360)
                .offset(x: 140 + offset2 * 8, y: 120 + offset2 * -5)

            // Ambient gradient orb 3 — center, subtle gold
            Circle()
                .fill(
                    RadialGradient(
                        gradient: Gradient(colors: [
                            VellumTheme.onboardingAccent.opacity(0.04),
                            Color.clear,
                        ]),
                        center: .center,
                        startRadius: 0,
                        endRadius: 150
                    )
                )
                .frame(width: 300, height: 300)
                .offset(x: 30 + offset3 * -6, y: -20 + offset3 * 8)
        }
        .ignoresSafeArea()
        .onAppear {
            withAnimation(.easeInOut(duration: 8).repeatForever(autoreverses: true)) {
                offset1 = 1
            }
            withAnimation(.easeInOut(duration: 10).repeatForever(autoreverses: true)) {
                offset2 = 1
            }
            withAnimation(.easeInOut(duration: 12).repeatForever(autoreverses: true)) {
                offset3 = 1
            }
        }
    }
}

#Preview {
    OnboardingBackground()
        .frame(width: 600, height: 500)
}

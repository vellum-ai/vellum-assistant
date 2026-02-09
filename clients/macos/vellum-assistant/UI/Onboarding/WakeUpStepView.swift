import SwiftUI

struct WakeUpStepView: View {
    @Bindable var state: OnboardingState

    @State private var showSubtext = false
    @State private var showButton = false

    var body: some View {
        VStack(spacing: 24) {
            TypewriterText(
                fullText: "Hello, world.",
                speed: 0.06,
                font: .system(.largeTitle, design: .serif)
            ) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    withAnimation(.easeOut(duration: 0.5)) {
                        showSubtext = true
                    }
                }
            }

            Text("I've been waiting for you.")
                .font(.system(size: 15))
                .foregroundColor(.white.opacity(0.5))
                .opacity(showSubtext ? 1 : 0)
                .offset(y: showSubtext ? 0 : 8)
                .onChange(of: showSubtext) { _, visible in
                    if visible {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                            withAnimation(.easeOut(duration: 0.5)) {
                                showButton = true
                            }
                        }
                    }
                }

            OnboardingButton(
                title: "Say hello",
                style: .primary
            ) {
                state.advance()
            }
            .opacity(showButton ? 1 : 0)
            .offset(y: showButton ? 0 : 8)
        }
    }
}

#Preview {
    ZStack {
        OnboardingBackground()
        WakeUpStepView(state: OnboardingState())
    }
    .frame(width: 600, height: 500)
}

import SwiftUI

struct WakeUpStepView: View {
    @Bindable var state: OnboardingState

    @State private var showSubtext = false
    @State private var showButton = false
    @State private var isHatching = false

    var body: some View {
        VStack(spacing: VellumSpacing.xxl) {
            TypewriterText(
                fullText: "Something is ready to hatch.",
                speed: 0.06,
                font: VellumFont.onboardingTitle
            ) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    withAnimation(.easeOut(duration: 0.5)) {
                        showSubtext = true
                    }
                }
            }

            Text("All it needs is you.")
                .font(VellumFont.onboardingSubtitle)
                .foregroundColor(VellumTheme.textSecondary)
                .opacity(showSubtext ? 1 : 0)
                .offset(y: showSubtext ? 0 : 8)
                .onChange(of: showSubtext) { _, visible in
                    if visible {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                            withAnimation(.easeOut(duration: 0.5)) {
                                showButton = true
                            }
                        }
                    }
                }

            OnboardingButton(title: "Hatch it!", style: .primary) {
                guard !isHatching else { return }
                if let trigger = state.hatchTrigger {
                    isHatching = true
                    trigger()
                } else {
                    state.advance()
                }
            }
            .opacity(showButton ? 1 : 0)
            .offset(y: showButton ? 0 : 8)
            .disabled(isHatching)
        }
        .onAppear {
            state.orbMood = .egg
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

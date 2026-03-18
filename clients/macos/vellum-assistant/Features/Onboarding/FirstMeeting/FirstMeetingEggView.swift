import VellumAssistantShared
import SwiftUI

@MainActor
struct FirstMeetingEggView: View {
    @Bindable var state: OnboardingState

    @State private var showButton = false
    @State private var isHatching = false

    var body: some View {
        VStack(spacing: VSpacing.xxl) {
            TypewriterText(
                fullText: "Something is waiting for you...",
                speed: 0.06,
                font: VFont.onboardingTitle
            ) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                    withAnimation(.easeOut(duration: 0.5)) {
                        showButton = true
                    }
                }
            }

            OnboardingButton(title: "Wake it up", style: .primary) {
                guard !isHatching else { return }
                isHatching = true
                state.hasHatched = true
                state.firstMeetingCrackProgress = 0.15
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                    state.advance()
                }
            }
            .opacity(showButton ? 1 : 0)
            .offset(y: showButton ? 0 : 8)
            .disabled(isHatching)
        }
    }
}

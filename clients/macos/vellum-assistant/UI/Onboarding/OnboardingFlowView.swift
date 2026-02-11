import SwiftUI

struct OnboardingFlowView: View {
    @Bindable var state: OnboardingState
    var onComplete: () -> Void
    var onOpenSettings: () -> Void

    var body: some View {
        ZStack {
            OnboardingBackground()

            VStack(spacing: 0) {
                // Egg area — progressively cracks as user advances, hatches at final step
                OnboardingHatchView(currentStep: state.currentStep, hasHatched: $state.hasHatched)
                    .padding(.top, 24)
                    .padding(.bottom, 12)

                // Step content — scrollable bottom area
                ScrollView(.vertical, showsIndicators: false) {
                    Group {
                        switch state.currentStep {
                        case 0:
                            WakeUpStepView(state: state)
                        case 1:
                            NamingStepView(state: state)
                        case 2:
                            FnKeyStepView(state: state)
                        case 3:
                            SpeechPermissionStepView(state: state)
                        case 4:
                            AccessibilityPermissionStepView(state: state)
                        case 5:
                            ScreenPermissionStepView(state: state)
                        case 6:
                            AliveStepView(
                                state: state,
                                onComplete: onComplete,
                                onOpenSettings: onOpenSettings
                            )
                        default:
                            EmptyView()
                        }
                    }
                    .transition(
                        .opacity.combined(with: .scale(scale: 0.97))
                    )
                    .id(state.currentStep)
                    .padding(.bottom, 24)
                }

                Spacer(minLength: 0)
            }
        }
        .frame(width: 600, height: 580)
        .animation(.easeOut(duration: 0.8), value: state.currentStep)
    }
}

#Preview {
    OnboardingFlowView(
        state: OnboardingState(),
        onComplete: {},
        onOpenSettings: {}
    )
}

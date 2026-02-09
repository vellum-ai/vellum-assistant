import SwiftUI

struct OnboardingFlowView: View {
    @Bindable var state: OnboardingState
    var onComplete: () -> Void
    var onOpenSettings: () -> Void

    var body: some View {
        ZStack {
            OnboardingBackground()

            VStack(spacing: 0) {
                // Orb area — always visible at top, progressively larger
                SoulOrbView(mood: state.orbMood, size: orbSize)
                    .animation(.easeOut(duration: 0.8), value: orbSize)
                    .padding(.top, 60)
                    .padding(.bottom, 32)

                // Step content — bottom area
                Group {
                    switch state.currentStep {
                    case 0:
                        WakeUpStepView(state: state)
                    case 1:
                        NamingStepView(state: state)
                    case 2:
                        FnKeyStepView(state: state)
                    case 3:
                        MicPermissionStepView(state: state)
                    case 4:
                        ScreenPermissionStepView(state: state)
                    case 5:
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
                .frame(maxHeight: .infinity)
            }
        }
        .frame(width: 600, height: 500)
        .animation(.easeOut(duration: 0.8), value: state.currentStep)
    }

    private var orbSize: CGFloat {
        switch state.currentStep {
        case 0: return 48
        case 5: return 72
        default: return 56
        }
    }
}

#Preview {
    OnboardingFlowView(
        state: OnboardingState(),
        onComplete: {},
        onOpenSettings: {}
    )
}

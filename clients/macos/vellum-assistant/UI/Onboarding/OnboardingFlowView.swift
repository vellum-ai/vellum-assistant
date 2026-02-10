import SwiftUI

struct OnboardingFlowView: View {
    @Bindable var state: OnboardingState
    var onComplete: () -> Void
    var onOpenSettings: () -> Void

    var body: some View {
        ZStack {
            OnboardingBackground()

            VStack(spacing: 0) {
                // Orb area — egg hatch on step 0, dino after hatch, fallback orb
                Group {
                    if state.currentStep == 0 {
                        OnboardingHatchView(state: state)
                    } else if state.hasHatched {
                        CreatureView(visible: true, animated: false)
                            .scaleEffect(creatureScale)
                            .frame(width: 200, height: 180)
                            .clipped()
                    } else {
                        SoulOrbView(mood: state.orbMood, size: orbSize)
                    }
                }
                    .animation(nil, value: state.currentStep)
                    .padding(.top, 40)
                    .padding(.bottom, 20)

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

                Spacer()
            }
        }
        .frame(width: 600, height: 500)
        .animation(.easeOut(duration: 0.8), value: state.currentStep)
    }

    private var orbSize: CGFloat {
        switch state.currentStep {
        case 0: return 44
        case 1: return 52
        case 2: return 56
        case 3...5: return 60
        case 6: return 72
        default: return 56
        }
    }

    private var creatureScale: CGFloat {
        switch state.currentStep {
        case 0...1: return 0.30
        case 2: return 0.32
        case 3...5: return 0.34
        case 6: return 0.38
        default: return 0.32
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

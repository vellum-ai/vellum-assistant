import SwiftUI

struct OnboardingFlowView: View {
    @Bindable var state: OnboardingState
    var onComplete: () -> Void
    var onOpenSettings: () -> Void

    var body: some View {
        ZStack {
            MeadowBackground()

            HStack(spacing: 0) {
                // LEFT: SpriteKit egg scene
                EggSceneView(state: state)
                    .frame(width: 280)

                // RIGHT: Dark panel with step content
                OnboardingPanel {
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
                }
                .frame(maxWidth: .infinity)
            }

            // Bottom caption
            VStack {
                Spacer()
                Text("Let\u{2019}s hatch this assistant by giving it enough permissions to live")
                    .font(VFont.onboardingSubtitle)
                    .foregroundColor(Meadow.captionText)
                    .padding(.bottom, VSpacing.lg)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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

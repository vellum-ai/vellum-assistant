import SwiftUI
import VellumAssistantShared

@MainActor
struct OnboardingFlowView: View {
    @Bindable var state: OnboardingState
    let daemonClient: DaemonClientProtocol
    @Bindable var authManager: AuthManager
    var onComplete: () -> Void
    var onOpenSettings: () -> Void

    @State private var isAdvancingFromWakeUp = false

    private var maxOnboardingStep: Int {
        state.userHostedEnabled ? 2 : 1
    }

    var body: some View {
        GeometryReader { geometry in
        ZStack {
            VColor.background.ignoresSafeArea()

            if state.isHatching {
                HatchingStepView(state: state)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(
                        RadialGradient(
                            colors: [
                                adaptiveColor(light: Slate._100, dark: Slate._900),
                                adaptiveColor(light: Slate._200, dark: Slate._950)
                            ],
                            center: .center,
                            startRadius: 0,
                            endRadius: 500
                        )
                        .ignoresSafeArea()
                    )
            } else if (0...maxOnboardingStep).contains(state.currentStep) {
                // Trimmed onboarding flow.
                // When userHostedEnabled: WakeUp → APIKey → CloudCredentials (steps 0–2)
                // Otherwise: WakeUp → APIKey (steps 0–1)
                VStack(spacing: 0) {
                    Spacer()

                    // Persistent evolving avatar — stays in place across step transitions
                    EvolvingAvatarView(evolutionState: state.avatarEvolutionState, animated: true)
                        .scaleEffect(0.3)
                        .frame(width: 128, height: 128)
                        .padding(.bottom, VSpacing.xxl)

                    // Step content — Group flattens into parent VStack so
                    // the inner Spacer flexes with the top Spacer above.
                    Group {
                        switch state.currentStep {
                        case 0:
                            WakeUpStepView(
                                state: state,
                                authManager: authManager,
                                isAdvancing: isAdvancingFromWakeUp,
                                onStartWithAPIKey: {
                                    guard !isAdvancingFromWakeUp else { return }
                                    isAdvancingFromWakeUp = true
                                    state.hasHatched = true
                                    DeterministicEvolutionEngine.applyMilestone(.hatched, to: state.avatarEvolutionState)
                                    state.avatarEvolutionState.save()
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                                        state.advance()
                                    }
                                },
                                onContinueWithVellum: {
                                    Task {
                                        await authManager.startWorkOSLogin()
                                    }
                                }
                            )
                        case 1:
                            APIKeyStepView(state: state)
                        case 2:
                            CloudCredentialsStepView(state: state)
                        default:
                            EmptyView()
                        }
                    }
                    .transition(
                        .asymmetric(
                            insertion: .opacity.combined(with: .offset(y: 12)),
                            removal: .opacity.combined(with: .offset(y: -8))
                        )
                    )
                    .id(state.currentStep)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(
                    RadialGradient(
                        colors: [
                            adaptiveColor(light: Stone._100, dark: Slate._900),
                            adaptiveColor(light: Stone._200, dark: Slate._950)
                        ],
                        center: .center,
                        startRadius: 0,
                        endRadius: 500
                    )
                    .ignoresSafeArea()
                )
            }
        }
        }
        .ignoresSafeArea()
        .onChange(of: state.currentStep) { _, newStep in
            if newStep == 0 {
                isAdvancingFromWakeUp = false
            }
            if newStep > maxOnboardingStep {
                onComplete()
            }
        }
        .onChange(of: authManager.isAuthenticated) { _, isAuthenticated in
            if isAuthenticated {
                onComplete()
            }
        }
        .onChange(of: state.hatchCompleted) { _, completed in
            if completed {
                onComplete()
            }
        }
    }

}

#Preview {
    OnboardingFlowView(
        state: OnboardingState(),
        daemonClient: DaemonClient(),
        authManager: AuthManager(),
        onComplete: {},
        onOpenSettings: {}
    )
}

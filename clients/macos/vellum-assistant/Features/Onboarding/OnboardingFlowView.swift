import SwiftUI
import VellumAssistantShared

@MainActor
struct OnboardingFlowView: View {
    @Bindable var state: OnboardingState
    let daemonClient: DaemonClientProtocol
    var onComplete: () -> Void
    var onOpenSettings: () -> Void

    var body: some View {
        GeometryReader { geometry in
        ZStack {
            VColor.background.ignoresSafeArea()

            if state.currentStep == 0 {
                // Step 0: Full-window welcome screen
                WakeUpStepView(state: state)
                    .transition(
                        .asymmetric(
                            insertion: .opacity.combined(with: .offset(y: 12)),
                            removal: .opacity.combined(with: .offset(y: -8))
                        )
                    )
                    .id(state.currentStep)
            } else if state.currentStep == 2 {
                // Step 2: Full-window API key screen
                APIKeyStepView(state: state)
                    .transition(
                        .asymmetric(
                            insertion: .opacity.combined(with: .offset(y: 12)),
                            removal: .opacity.combined(with: .offset(y: -8))
                        )
                    )
                    .id(state.currentStep)
            } else if state.currentStep == 3 {
                // Step 3: Full-window voice activation screen
                FnKeyStepView(state: state)
                    .transition(
                        .asymmetric(
                            insertion: .opacity.combined(with: .offset(y: 12)),
                            removal: .opacity.combined(with: .offset(y: -8))
                        )
                    )
                    .id(state.currentStep)
            } else if state.currentStep <= 7 {
                // Steps 1-7: Egg + content panel layout
                VStack(spacing: 0) {
                    // TOP: Stage image (egg)
                    OnboardingStageImage(currentStep: state.currentStep)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding(.horizontal, VSpacing.xxl)

                    // BOTTOM: Content panel
                    VStack(spacing: VSpacing.lg) {
                        Group {
                            switch state.currentStep {
                            case 1:
                                NamingStepView(state: state)
                            case 2:
                                APIKeyStepView(state: state)
                            case 3:
                                FnKeyStepView(state: state)
                            case 4:
                                SpeechPermissionStepView(state: state)
                            case 5:
                                AccessibilityPermissionStepView(state: state)
                            case 6:
                                ScreenPermissionStepView(state: state)
                            case 7:
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
                            .asymmetric(
                                insertion: .opacity.combined(with: .offset(y: 12)),
                                removal: .opacity.combined(with: .offset(y: -8))
                            )
                        )
                        .id(state.currentStep)

                        OnboardingProgressDots(currentStep: state.currentStep)
                            .padding(.top, VSpacing.xs)
                    }
                    .padding(.horizontal, VSpacing.xxl)
                    .padding(.top, VSpacing.xl)
                    .padding(.bottom, VSpacing.xxl)
                    .frame(maxWidth: .infinity)
                    .background(VColor.background)
                }
                .ignoresSafeArea(edges: .top)
            } else {
                // Step 8: Interview — manages its own layout
                InterviewStepView(
                    state: state,
                    daemonClient: daemonClient,
                    onComplete: onComplete
                )
                .transition(
                    .opacity.combined(with: .scale(scale: 0.97))
                )
                .id(state.currentStep)
            }
        }
        }
        .ignoresSafeArea()
        .onChange(of: state.currentStep) { _, newStep in
            if newStep > 3 {
                onComplete()
            }
        }
    }

    // MARK: - Mock Chrome

    private var mockToolbar: some View {
        HStack {
            Spacer()

            HStack(spacing: VSpacing.sm) {
                ForEach(["Automated", "Agent", "Control", "System"], id: \.self) { tab in
                    HStack(spacing: 4) {
                        Image(systemName: "circle")
                            .font(.system(size: 7))
                        Text(tab)
                    }
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.sm)
                    .background(VColor.surface.opacity(0.3))
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                }
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.top, 44) // below titlebar
    }

    private var mockInputBar: some View {
        HStack(spacing: VSpacing.md) {
            VCircleButton(icon: "phone.fill", label: "Phone", fillColor: Emerald._600.opacity(0.5)) { }

            Text("What you need chef?")
                .font(VFont.body)
                .foregroundColor(VColor.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.md)
                .background(VColor.surface.opacity(0.3))
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.bottom, VSpacing.lg)
    }
}

#Preview {
    OnboardingFlowView(
        state: OnboardingState(),
        daemonClient: DaemonClient(),
        onComplete: {},
        onOpenSettings: {}
    )
}

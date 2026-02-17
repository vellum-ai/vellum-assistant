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

            if [0, 2, 3, 4].contains(state.currentStep) {
                // Steps 0–4: Shared layout with persistent icon + background.
                // Only the content below the icon transitions between steps.
                VStack(spacing: 0) {
                    Spacer()

                    // Persistent icon — stays in place across step transitions
                    Group {
                        if let url = ResourceBundle.bundle.url(forResource: "stage-3", withExtension: "png"),
                           let nsImage = NSImage(contentsOf: url) {
                            Image(nsImage: nsImage)
                                .resizable()
                                .interpolation(.none)
                                .aspectRatio(contentMode: .fit)
                        } else {
                            Image("VellyLogo")
                                .resizable()
                                .interpolation(.none)
                                .aspectRatio(contentMode: .fit)
                        }
                    }
                    .frame(width: 128, height: 128)
                    .padding(.bottom, VSpacing.xxl)

                    // Step content — Group flattens into parent VStack so
                    // the inner Spacer flexes with the top Spacer above.
                    Group {
                        switch state.currentStep {
                        case 0:
                            WakeUpStepView(state: state)
                        case 2:
                            APIKeyStepView(state: state)
                        case 3:
                            ModelSelectionStepView(state: state)
                        case 4:
                            FnKeyStepView(state: state)
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
                    ZStack {
                        VColor.background

                        RadialGradient(
                            colors: [
                                Violet._600.opacity(0.15),
                                Violet._700.opacity(0.05),
                                Color.clear
                            ],
                            center: .bottom,
                            startRadius: 20,
                            endRadius: 350
                        )

                        RadialGradient(
                            colors: [
                                Violet._400.opacity(0.08),
                                Color.clear
                            ],
                            center: UnitPoint(x: 0.7, y: 1.0),
                            startRadius: 10,
                            endRadius: 250
                        )
                    }
                    .ignoresSafeArea()
                )
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

                        OnboardingFooter(currentStep: state.currentStep)
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
            if newStep > 4 {
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

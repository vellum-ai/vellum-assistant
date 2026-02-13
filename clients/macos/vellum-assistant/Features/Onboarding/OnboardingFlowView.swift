import SwiftUI

@MainActor
struct OnboardingFlowView: View {
    @Bindable var state: OnboardingState
    let daemonClient: DaemonClientProtocol
    var onComplete: () -> Void
    var onOpenSettings: () -> Void

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                VColor.background
                    .ignoresSafeArea()

                // Dimmed mock chrome — gives the "chat UI behind" effect
                VStack(spacing: 0) {
                    mockToolbar
                    Spacer()
                    mockInputBar
                }
                .opacity(0.25)
                .allowsHitTesting(false)

                if state.currentStep <= 6 {
                    // Vertical card layout (steps 0-6)
                    VStack(spacing: 0) {
                        // TOP: Meadow background + stage image
                        ZStack {
                            MeadowBackground()

                            OnboardingStageImage(currentStep: state.currentStep)
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                                .padding(VSpacing.xxl)
                        }
                        .frame(height: 350)
                        .clipped()

                        // BOTTOM: Dark content panel
                        VStack(spacing: VSpacing.lg) {
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
                        .background(
                            Rectangle()
                                .fill(.ultraThinMaterial)
                                .overlay(
                                    Rectangle()
                                        .fill(Meadow.panelBackground)
                                )
                        )
                    }
                    .frame(maxWidth: 640)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.xl)
                            .stroke(Meadow.panelBorder, lineWidth: 1)
                    )
                    .shadow(color: .black.opacity(0.4), radius: 24, y: 12)
                    .position(x: geometry.size.width / 2, y: geometry.size.height / 2)
                } else {
                    // Step 7: Interview — manages its own layout
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
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
        .ignoresSafeArea()
    }

    // MARK: - Mock Chrome

    private var mockToolbar: some View {
        HStack {
            HStack(spacing: 6) {
                Image(systemName: "bubble.left")
                    .font(.system(size: 11))
                Text("Chat")
                    .font(VFont.bodyMedium)
            }
            .foregroundColor(VColor.textPrimary)
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(VColor.surface.opacity(0.5))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

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

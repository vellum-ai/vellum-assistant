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
    @State private var isBootstrappingManaged = false
    @State private var managedBootstrapError: String?

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
                                adaptiveColor(light: Moss._100, dark: Moss._900),
                                adaptiveColor(light: Moss._200, dark: Moss._950)
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

                    if let iconPath = ResourceBundle.bundle.path(forResource: "vellum-app-icon", ofType: "png"),
                       let nsImage = NSImage(contentsOfFile: iconPath) {
                        Image(nsImage: nsImage)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(width: 96, height: 96)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
                            .padding(.bottom, VSpacing.lg)
                    }

                    // Step content — Group flattens into parent VStack so
                    // the inner Spacer flexes with the top Spacer above.
                    Group {
                        if isBootstrappingManaged {
                            managedBootstrapView
                        } else {
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
                    }
                    .transition(
                        .asymmetric(
                            insertion: .opacity.combined(with: .offset(y: 12)),
                            removal: .opacity.combined(with: .offset(y: -8))
                        )
                    )
                    .id(isBootstrappingManaged ? -1 : state.currentStep)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(
                    RadialGradient(
                        colors: [
                            adaptiveColor(light: Stone._100, dark: Moss._900),
                            adaptiveColor(light: Stone._200, dark: Moss._950)
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
                Task {
                    await performManagedBootstrap()
                }
            }
        }
        .onChange(of: state.hatchCompleted) { _, completed in
            if completed {
                onComplete()
            }
        }
    }

    // MARK: - Managed Bootstrap

    @ViewBuilder
    private var managedBootstrapView: some View {
        VStack(spacing: VSpacing.lg) {
            if managedBootstrapError == nil {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                        .progressViewStyle(.circular)
                    Text("Setting up your assistant...")
                        .font(VFont.monoMedium)
                        .foregroundColor(VColor.textSecondary)
                }
            } else {
                Text("Setup failed")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(VColor.textPrimary)

                if let error = managedBootstrapError {
                    Text(error)
                        .font(VFont.caption)
                        .foregroundColor(VColor.error)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 280)
                }

                OnboardingButton(title: "Try again", style: .primary) {
                    Task {
                        await performManagedBootstrap()
                    }
                }
                .frame(maxWidth: 280)
            }
        }

        Spacer()
    }

    private func performManagedBootstrap() async {
        isBootstrappingManaged = true
        managedBootstrapError = nil

        do {
            let outcome = try await ManagedAssistantBootstrapService.shared.ensureManagedAssistant()

            let assistant: PlatformAssistant
            switch outcome {
            case .reusedExisting(let existing):
                assistant = existing
            case .createdNew(let created):
                assistant = created
            }

            let runtimeUrl = AuthService.shared.baseURL
            let hatchedAt = ISO8601DateFormatter().string(from: Date())

            let success = LockfileAssistant.upsertManagedEntry(
                assistantId: assistant.id,
                runtimeUrl: runtimeUrl,
                hatchedAt: hatchedAt
            )

            guard success else {
                isBootstrappingManaged = false
                managedBootstrapError = "Failed to save assistant configuration. Please try again."
                return
            }

            UserDefaults.standard.set(assistant.id, forKey: "connectedAssistantId")

            isBootstrappingManaged = false
            onComplete()
        } catch {
            managedBootstrapError = error.localizedDescription
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

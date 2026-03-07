import SwiftUI
import VellumAssistantShared

@MainActor
struct OnboardingFlowView: View {
    @Bindable var state: OnboardingState
    let daemonClient: DaemonClientProtocol
    @Bindable var authManager: AuthManager
    let managedBootstrapEnabled: Bool
    var onComplete: () -> Void
    var onOpenSettings: () -> Void

    @State private var isAdvancingFromWakeUp = false
    @State private var isBootstrappingManaged = false
    @State private var managedBootstrapError: String?
    @State private var isBootstrappingLocal = false
    @State private var localBootstrapError: String?

    private static let appIcon: NSImage? = {
        guard let path = ResourceBundle.bundle.path(forResource: "vellum-app-icon", ofType: "png") else { return nil }
        return NSImage(contentsOfFile: path)
    }()

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

                    if let nsImage = Self.appIcon {
                        Image(nsImage: nsImage)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(width: 96, height: 96)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
                            .padding(.bottom, VSpacing.xl)
                    }

                    // Step content — Group flattens into parent VStack so
                    // the inner Spacer flexes with the top Spacer above.
                    Group {
                        if isBootstrappingManaged {
                            managedBootstrapView
                        } else if isBootstrappingLocal {
                            localBootstrapView
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
                    .id(isBootstrappingManaged ? -1 : isBootstrappingLocal ? -2 : state.currentStep)
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
                let currentAssistant = LockfileAssistant.loadLatest()
                if let assistant = currentAssistant {
                    if assistant.isManaged {
                        Task {
                            await performManagedBootstrap()
                        }
                    } else if !assistant.isRemote {
                        Task {
                            await performLocalBootstrap(assistant: assistant)
                        }
                    } else {
                        onComplete()
                    }
                } else if managedBootstrapEnabled {
                    Task {
                        await performManagedBootstrap()
                    }
                } else {
                    onComplete()
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
                    .font(VFont.title)
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
            let isoFormatter = ISO8601DateFormatter()
            isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let hatchedAt = isoFormatter.string(from: Date())

            let success = LockfileAssistant.upsertManagedEntry(
                assistantId: assistant.id,
                runtimeUrl: runtimeUrl,
                hatchedAt: hatchedAt
            )

            guard success else {
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

    // MARK: - Local Bootstrap

    @ViewBuilder
    private var localBootstrapView: some View {
        VStack(spacing: VSpacing.lg) {
            if localBootstrapError == nil {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                        .progressViewStyle(.circular)
                    Text("Registering your assistant...")
                        .font(VFont.monoMedium)
                        .foregroundColor(VColor.textSecondary)
                }
            } else {
                Text("Registration failed")
                    .font(VFont.title)
                    .foregroundColor(VColor.textPrimary)

                if let error = localBootstrapError {
                    Text(error)
                        .font(VFont.caption)
                        .foregroundColor(VColor.error)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 280)
                }

                OnboardingButton(title: "Try again", style: .primary) {
                    Task {
                        if let assistant = LockfileAssistant.loadLatest(), !assistant.isRemote {
                            await performLocalBootstrap(assistant: assistant)
                        }
                    }
                }
                .frame(maxWidth: 280)
            }
        }

        Spacer()
    }

    private func performLocalBootstrap(assistant: LockfileAssistant) async {
        isBootstrappingLocal = true
        localBootstrapError = nil

        // Resolve the daemon's HTTP base URL and bearer token
        let portString = ProcessInfo.processInfo.environment["RUNTIME_HTTP_PORT"] ?? "7821"
        let port = Int(portString) ?? 7821
        let daemonBaseURL = "http://localhost:\(port)"

        guard let daemonToken = ActorTokenManager.getToken(), !daemonToken.isEmpty else {
            localBootstrapError = "No assistant credentials available. Please restart the assistant and try again."
            return
        }

        do {
            let bootstrapService = LocalAssistantBootstrapService(credentialStorage: KeychainCredentialStorage())
            let outcome = try await bootstrapService.bootstrap(
                runtimeAssistantId: assistant.assistantId,
                clientPlatform: "macos",
                daemonBaseURL: daemonBaseURL,
                daemonToken: daemonToken
            )

            switch outcome {
            case .registeredWithExistingKey, .registeredAndProvisioned:
                UserDefaults.standard.set(assistant.assistantId, forKey: "connectedAssistantId")
            }

            isBootstrappingLocal = false
            onComplete()
        } catch {
            localBootstrapError = error.localizedDescription
        }
    }

}

#Preview {
    OnboardingFlowView(
        state: OnboardingState(),
        daemonClient: DaemonClient(),
        authManager: AuthManager(),
        managedBootstrapEnabled: true,
        onComplete: {},
        onOpenSettings: {}
    )
}

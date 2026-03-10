import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "OnboardingFlowView")

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

    private static let appIcon: NSImage? = {
        guard let path = ResourceBundle.bundle.path(forResource: "vellum-app-icon", ofType: "png") else { return nil }
        return NSImage(contentsOfFile: path)
    }()

    private var maxOnboardingStep: Int {
        state.userHostedEnabled ? 3 : 2
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
                                VColor.background,
                                VColor.onboardingHatchGradientOuter
                            ],
                            center: .center,
                            startRadius: 0,
                            endRadius: 500
                        )
                        .ignoresSafeArea()
                    )
            } else if (0...maxOnboardingStep).contains(state.currentStep) {
                // Trimmed onboarding flow.
                // When userHostedEnabled: WakeUp → APIKey → CloudCredentials → ImproveExperience (steps 0–3)
                // Otherwise: WakeUp → APIKey → ImproveExperience (steps 0–2)
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
                                if state.needsCloudCredentials {
                                    CloudCredentialsStepView(state: state)
                                } else {
                                    ImproveExperienceStepView(state: state)
                                }
                            case 3:
                                ImproveExperienceStepView(state: state)
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
                            VColor.onboardingGradientEdge,
                            VColor.onboardingGradientOuter
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
            let currentAssistant = LockfileAssistant.loadLatest()
            log.info(
                "Observed auth state change in onboarding: isAuthenticated=\(isAuthenticated, privacy: .public) managedBootstrapEnabled=\(self.managedBootstrapEnabled, privacy: .public) lockfileAssistantId=\(currentAssistant?.assistantId ?? "<none>", privacy: .public)"
            )
            if isAuthenticated {
                if let assistant = currentAssistant {
                    if assistant.isManaged {
                        log.info("Authenticated with managed assistant \(assistant.assistantId, privacy: .public); starting managed bootstrap")
                        Task {
                            await performManagedBootstrap()
                        }
                    } else if !assistant.isRemote {
                        log.info("Auth completed for local assistant \(assistant.assistantId, privacy: .public) — deferring local registration until app startup")
                        onComplete()
                    } else {
                        log.info("Auth completed for remote assistant \(assistant.assistantId, privacy: .public) — proceeding to app")
                        onComplete()
                    }
                } else if managedBootstrapEnabled {
                    log.info("Authenticated with no lockfile assistant; starting managed bootstrap")
                    Task {
                        await performManagedBootstrap()
                    }
                } else {
                    log.info("Auth completed with no lockfile assistant — proceeding to app")
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
        log.info("Beginning managed assistant bootstrap")

        do {
            let outcome = try await ManagedAssistantBootstrapService.shared.ensureManagedAssistant()

            let assistant: PlatformAssistant
            switch outcome {
            case .reusedExisting(let existing):
                assistant = existing
                log.info("Managed bootstrap reused existing assistant \(assistant.id, privacy: .public)")
            case .createdNew(let created):
                assistant = created
                log.info("Managed bootstrap created new assistant \(assistant.id, privacy: .public)")
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
                log.error("Managed bootstrap failed to persist lockfile entry for assistant \(assistant.id, privacy: .public)")
                return
            }

            UserDefaults.standard.set(assistant.id, forKey: "connectedAssistantId")

            isBootstrappingManaged = false
            log.info("Managed bootstrap completed for assistant \(assistant.id, privacy: .public); proceeding to app")
            onComplete()
        } catch {
            log.error("Managed bootstrap failed: \(error.localizedDescription)")
            managedBootstrapError = error.localizedDescription
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

import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "OnboardingFlowView")

@MainActor
struct OnboardingFlowView: View {
    @Bindable var state: OnboardingState
    let connectionManager: GatewayConnectionManager
    @Bindable var authManager: AuthManager
    let managedBootstrapEnabled: Bool
    var onComplete: () -> Void
    var onOpenSettings: () -> Void

    @State private var isAdvancingFromWakeUp = false
    @State private var isResolvingAssociatedManagedAssistant = false
    @State private var didCallComplete = false
    @State private var completionDelayTask: Task<Void, Never>?
    @State private var isShowingPreChat = false

    private static let appIcon: NSImage = {
        NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)
    }()

    private var managedSignInEnabled: Bool {
        MacOSClientFeatureFlagManager.shared.isEnabled("managed-sign-in")
    }

    private var maxOnboardingStep: Int {
        return 3
    }

    var body: some View {
        GeometryReader { geometry in
        ZStack {
            VColor.surfaceOverlay.ignoresSafeArea()

            if isShowingPreChat {
                PreChatOnboardingFlow { context in
                    state.preChatContext = context
                    // Update assistant name if user changed it during pre-chat
                    if let newName = context?.assistantName, !newName.isEmpty, newName != state.assistantName {
                        state.assistantName = newName
                    }
                    isShowingPreChat = false
                    onComplete()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(
                    RadialGradient(
                        colors: [
                            VColor.surfaceBase,
                            VColor.surfaceOverlay
                        ],
                        center: .center,
                        startRadius: 0,
                        endRadius: 500
                    )
                    .ignoresSafeArea()
                )
                .transition(.opacity)
            } else if state.isHatching {
                HatchingStepView(state: state, onRetryManaged: {
                    await performManagedBootstrap()
                })
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(
                        RadialGradient(
                            colors: [
                                VColor.surfaceOverlay,
                                VColor.surfaceOverlay
                            ],
                            center: .center,
                            startRadius: 0,
                            endRadius: 500
                        )
                        .ignoresSafeArea()
                    )
            } else if (0...maxOnboardingStep).contains(state.currentStep) {
                // Onboarding flow: WakeUp → HostingSelector → APIKeyEntry → ImproveExperience (steps 0–3)
                ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 0) {
                    if state.currentStep == 0 {
                        // Step 0 only: top inset + app icon
                        Color.clear.frame(height: 80)

                        Image(nsImage: Self.appIcon)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(width: 80, height: 80)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                            .shadow(color: VColor.auxBlack.opacity(0.15), radius: 1, x: 0, y: 1)
                            .padding(.bottom, 78)
                    } else {
                        // Steps 1–3: top inset only (no icon)
                        Color.clear.frame(height: VSpacing.xxxl)
                    }

                    // Step content — Group flattens into parent VStack so
                    // the inner Spacer flexes with the top Spacer above.
                    Group {
                        switch state.currentStep {
                            case 0:
                                if authManager.isAuthenticated {
                                    // Already authenticated — show a brief loading
                                    // state while the .task advances to Setup.
                                    HStack(spacing: VSpacing.sm) {
                                        ProgressView()
                                            .controlSize(.small)
                                            .progressViewStyle(.circular)
                                    }

                                    Spacer()
                                } else {
                                    WakeUpStepView(
                                        state: state,
                                        authManager: authManager,
                                        isAdvancing: isAdvancingFromWakeUp,
                                        managedSignInEnabled: true,
                                        onStartWithAPIKey: {
                                            guard !isAdvancingFromWakeUp else { return }
                                            isAdvancingFromWakeUp = true
                                            state.hasHatched = true
                                            Task { @MainActor in
                                                try? await Task.sleep(nanoseconds: 300_000_000)
                                                guard !Task.isCancelled else { return }
                                                state.advance()
                                            }
                                        },
                                        onContinueWithVellum: {
                                            Task {
                                                await continueWithManagedAssistant()
                                            }
                                        }
                                    )
                                }
                            case 1:
                                APIKeyStepView(
                                    state: state,
                                    isAuthenticated: authManager.isAuthenticated,
                                    onHatchManaged: {
                                        Task {
                                            await performManagedBootstrap()
                                        }
                                    }
                                )
                            case 2:
                                APIKeyEntryStepView(state: state)
                            case 3:
                                ImproveExperienceStepView(
                                    state: state,
                                    skippedAPIKeyEntry: state.skippedAPIKeyEntry,
                                    onAccepted: state.selectedHostingMode == .vellumCloud ? {
                                        Task {
                                            await performManagedBootstrap()
                                        }
                                    } : nil
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
                }
                .frame(maxWidth: .infinity, minHeight: geometry.size.height, alignment: .top)
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(
                    RadialGradient(
                        colors: [
                            VColor.surfaceBase,
                            VColor.surfaceOverlay
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
        .frame(minWidth: 440, minHeight: 630)
        .task {
            if !authManager.isAuthenticated {
                await authManager.checkSession()
            }
            if authManager.isAuthenticated && state.currentStep == 0 {
                await continueManagedOnboardingAfterAuthentication()
            }
        }
        .onChange(of: state.currentStep) { _, newStep in
            if newStep == 0 {
                isAdvancingFromWakeUp = false
                if authManager.isAuthenticated {
                    Task {
                        await continueManagedOnboardingAfterAuthentication()
                    }
                }
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
            if !isAuthenticated && state.currentStep > 0 {
                log.info("User signed out during managed onboarding — returning to welcome screen")
                completionDelayTask?.cancel()
                didCallComplete = false
                state.isHatching = false
                state.hatchProcessStarted = false
                state.isManagedHatch = false
                state.hatchCompleted = false
                state.hatchFailed = false
                state.hatchFailureReason = nil
                state.hatchProgressTarget = 0.0
                state.hatchProgressDisplay = 0.0
                state.hatchStepLabel = nil
                state.hatchTotalSteps = 1
                state.hatchCurrentStep = 0
                isShowingPreChat = false
                withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
                    state.currentStep = 0
                }
                return
            }
            if isAuthenticated {
                if let assistant = currentAssistant {
                    if assistant.isManaged && state.currentStep == 0 {
                        log.info("Authenticated with managed assistant \(assistant.assistantId, privacy: .public); advancing to hosting selector")
                        state.advance()
                    } else if assistant.isManaged {
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
                    if state.currentStep == 0 {
                        Task {
                            await continueManagedOnboardingAfterAuthentication()
                        }
                    } else {
                        log.info("Session restored with no lockfile assistant — staying on welcome screen for user-initiated hatch")
                    }
                } else {
                    log.info("Auth completed with no lockfile assistant — proceeding to app")
                    onComplete()
                }
            }
        }
        .onChange(of: state.hatchCompleted) { _, completed in
            if completed {
                guard !didCallComplete else { return }
                didCallComplete = true
                completionDelayTask = Task {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    guard !Task.isCancelled else { return }
                    guard state.hatchCompleted else { return }
                    PreChatOnboardingState.clearPersistedState()
                    withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
                        isShowingPreChat = true
                    }
                }
            }
        }
        .onDisappear {
            completionDelayTask?.cancel()
        }
    }

    // MARK: - Managed Bootstrap

    private func continueWithManagedAssistant() async {
        switch onboardingManagedContinuationAction(isAuthenticated: authManager.isAuthenticated) {
        case .startLogin:
            await authManager.startWorkOSLogin()
        case .bootstrap:
            state.advance()
        }
    }

    private func continueManagedOnboardingAfterAuthentication() async {
        guard managedBootstrapEnabled,
              authManager.isAuthenticated,
              state.currentStep == 0,
              !isResolvingAssociatedManagedAssistant else {
            return
        }

        isResolvingAssociatedManagedAssistant = true
        defer { isResolvingAssociatedManagedAssistant = false }

        // Reconcile the local lockfile against the platform's authoritative
        // list of managed assistants before deciding what to do. A fresh
        // sign-in on a new install (or a build that switched to env-scoped
        // lockfile paths) will have an empty lockfile even though the
        // account already owns assistants — pulling them in here lets the
        // post-auth flow resume directly into the app rather than dumping
        // the user back at the hosting selector.
        if !state.isRehatch {
            let router = ReturningUserRouter()
            if let landscape = try? await router.fetchLandscape(),
               landscape.platformWasConsulted {
                let result = LockfileReconciler.reconcile(
                    platformAssistants: landscape.platformAssistants
                )
                if result.didChange {
                    log.info("Lockfile reconciled: +\(result.added.count, privacy: .public) -\(result.removed.count, privacy: .public)")
                }
            }
        }

        // Only auto-proceed if there's already a managed assistant in the lockfile
        // AND this is a fresh onboarding (not a re-hatch from the developer tab).
        // Do NOT create a new managed assistant here — that should only happen if
        // the user explicitly selects Vellum Cloud on the hosting selector.
        if let existing = LockfileAssistant.loadLatest(), existing.isManaged, !state.isRehatch {
            log.info("Authenticated with existing managed assistant \(existing.assistantId, privacy: .public); proceeding to app")
            onComplete()
            return
        }

        log.info("Authenticated account has \(state.isRehatch ? "rehatch requested" : "no existing managed assistant", privacy: .public) — advancing to hosting selector")
        state.advance()
    }

    /// Extracts a human-readable message from an error string that may be JSON.
    private func humanReadableError(from raw: String) -> String {
        guard let data = raw.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let detail = json["detail"] as? String else {
            return raw
        }
        return detail
    }

    /// Drives the managed-hatch flow end-to-end inside `HatchingStepView`.
    ///
    /// The view is shown *before* the platform API call begins so the user sees
    /// a single consistent loading surface from tap to ready — errors from
    /// `activateManagedAssistant()` surface in the same view via the shared
    /// `hatchFailed` / `hatchFailureReason` path that the health-poll uses.
    private func performManagedBootstrap() async {
        // Apple Guideline 5.1.2(i): AI Data Sharing consent must be explicitly
        // checked by the user. Bootstrap can be triggered via the auth-change
        // path (line ~251) which doesn't route through onboarding step 3, so
        // we re-check consent here as the load-bearing enforcement point.
        // The HatchingStepView gate remains as defense-in-depth for non-managed
        // (CLI) hatch flows.
        let tosOk = UserDefaults.standard.bool(forKey: "tosAccepted")
        let aiOk = UserDefaults.standard.bool(forKey: "aiDataConsent")
        guard tosOk && aiOk else {
            log.info("Managed bootstrap aborted: AI Data Sharing consent missing — bouncing to privacy step")
            state.bounceToConsentStep()
            return
        }

        log.info("Beginning managed assistant bootstrap")
        state.hasExistingManagedAssistant = false
        state.hatchFailed = false
        state.hatchFailureReason = nil
        state.hatchCompleted = false
        state.hatchLogLines = []
        state.hatchTotalSteps = 3
        state.hatchCurrentStep = 0
        state.hatchProgressTarget = 0.0
        state.hatchStepLabel = "Setting up your assistant\u{2026}"
        state.isManagedHatch = true
        state.isHatching = true

        do {
            let coordinator = ManagedAssistantConnectionCoordinator()
            let activation: ManagedAssistantConnectionResult
            if state.isRehatch {
                activation = try await coordinator.activateNewManagedAssistant()
            } else {
                activation = try await coordinator.activateManagedAssistant()
            }
            let assistant = activation.assistant
            state.hasExistingManagedAssistant = activation.reusedExisting

            if activation.reusedExisting {
                log.info("Managed bootstrap reused existing assistant \(assistant.id, privacy: .public)")
            } else {
                log.info("Managed bootstrap created new assistant \(assistant.id, privacy: .public)")
            }

            log.info("Managed bootstrap completed for assistant \(assistant.id, privacy: .public); waiting for daemon connection")
            await awaitManagedAssistantReady(assistantId: assistant.id)
        } catch {
            log.error("Managed bootstrap failed: \(error.localizedDescription)")
            state.hatchFailureReason = humanReadableError(from: error.localizedDescription)
            state.hatchFailed = true
        }
    }

    /// Waits for a managed assistant to become fully provisioned and reachable.
    ///
    /// Phase 1: Polls `GET /v1/assistants/{id}/` until the platform reports the
    /// assistant's status as `"active"` (or the field is absent for backward compat).
    ///
    /// Phase 2: Polls the gateway health endpoint at the assistant-scoped path
    /// (`assistants/{assistantId}/health`) until the runtime responds successfully.
    private func awaitManagedAssistantReady(assistantId: String) async {
        // Phase 1: Wait for the platform to finish provisioning.
        guard !state.hatchCompleted else { return }
        state.hatchTotalSteps = 3
        state.hatchCurrentStep = 1
        state.hatchStepLabel = "Provisioning assistant..."
        state.hatchProgressTarget = 0.33

        do {
            try await ManagedAssistantBootstrapService.shared.awaitAssistantProvisioned(assistantId: assistantId)
        } catch {
            log.error("Provisioning poll failed for \(assistantId, privacy: .public): \(error.localizedDescription, privacy: .public)")
            state.hatchFailureReason = humanReadableError(from: error.localizedDescription)
            state.hatchFailed = true
            return
        }

        // Phase 2: Poll the assistant-scoped gateway health endpoint.
        guard !state.hatchCompleted else { return }
        state.hatchCurrentStep = 2
        state.hatchStepLabel = "Connecting to assistant..."
        state.hatchProgressTarget = 0.66

        // Use ContinuousClock rather than wall-clock so NTP adjustments or
        // DST transitions mid-poll don't shorten or extend the deadline.
        let timeout: Duration = .seconds(120)
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        var lastError: Error?
        var lastStatusCode: Int?

        while clock.now < deadline {
            do {
                let (_, response): (DaemonHealthz?, _) = try await GatewayHTTPClient.get(
                    path: "health",
                    timeout: 5
                ) { $0.keyDecodingStrategy = .convertFromSnakeCase }
                if response.isSuccess {
                    log.info("Managed assistant \(assistantId, privacy: .public) is ready")

                    // Inject client-resolvable vellum identity fields that
                    // Django's post-hatch provisioning doesn't cover (org
                    // id, user id). Local assistants get these via
                    // `LocalAssistantBootstrapService`; the managed hatch
                    // path skips that bootstrap, so onboarding has to
                    // inject them directly. Best-effort: skip when the
                    // org id isn't cached rather than blocking onboarding
                    // on a fresh lookup. `ensureManagedAssistant()`
                    // already resolved and persisted the org id earlier
                    // in the bootstrap.
                    if let organizationId = UserDefaults.standard.string(forKey: "connectedOrganizationId"),
                       !organizationId.isEmpty {
                        await ManagedAssistantIdentityInjection.inject(
                            into: assistantId,
                            organizationId: organizationId
                        )
                    } else {
                        log.warning("Skipping vellum identity injection — no cached organization id for \(assistantId, privacy: .public)")
                    }

                    state.hatchCurrentStep = 3
                    state.hatchStepLabel = "Ready"
                    state.hatchProgressTarget = 1.0
                    state.hatchCompleted = true
                    return
                }
                lastStatusCode = response.statusCode
                lastError = nil
                let body = String(data: response.data, encoding: .utf8) ?? "<non-utf8>"
                log.warning("Health check returned status \(response.statusCode) for assistant \(assistantId, privacy: .public): \(body, privacy: .public)")
            } catch {
                lastError = error
                lastStatusCode = nil
                log.warning("Health check request failed for assistant \(assistantId, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }

            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
        }

        let timeoutSeconds = Int(timeout.components.seconds)
        if let error = lastError {
            log.error("Managed assistant \(assistantId, privacy: .public) not ready after \(timeoutSeconds)s; last error: \(error.localizedDescription, privacy: .public)")
        } else if let statusCode = lastStatusCode {
            log.error("Managed assistant \(assistantId, privacy: .public) not ready after \(timeoutSeconds)s; last status code: \(statusCode)")
        } else {
            log.error("Managed assistant \(assistantId, privacy: .public) not ready after \(timeoutSeconds)s; no health check attempts completed")
        }
        state.hatchFailureReason = "Your assistant didn't respond in time. Please try again."
        state.hatchFailed = true
    }
}

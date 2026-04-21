import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ReauthView")

@MainActor
struct ReauthView: View {
    @Bindable var authManager: AuthManager
    var onComplete: () -> Void
    /// Invoked when `ReturningUserRouter` decides `.showHostingPicker`
    /// after re-auth (platform returned 0 assistants for this user).
    /// The host swaps this view for the onboarding hosting picker.
    var onNeedsHostingPicker: (() -> Void)?

    @State private var showContent = false
    @State private var didComplete = false
    @State private var hasNonManagedAssistant = false
    @State private var isActivatingManagedAssistant = false

    private static let appIcon: NSImage? = {
        guard let path = ResourceBundle.bundle.path(forResource: "vellum-app-icon", ofType: "png") else { return nil }
        return NSImage(contentsOfFile: path)
    }()

    var body: some View {
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

            Text("Welcome Back")
                .font(VFont.displayLarge)
                .foregroundStyle(VColor.contentDefault)
                .padding(.bottom, VSpacing.xs)

            Text("Log in to continue.")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentSecondary)
                .padding(.bottom, VSpacing.xxl)

            VStack(spacing: VSpacing.md) {
                if authManager.isLoading {
                    HStack(spacing: VSpacing.sm) {
                        ProgressView()
                            .controlSize(.small)
                            .progressViewStyle(.circular)
                        Text("Checking...")
                            .font(VFont.titleSmall)
                            .foregroundStyle(VColor.contentSecondary)
                    }
                    .frame(height: 36)
                } else if authManager.isSubmitting || isActivatingManagedAssistant {
                    HStack(spacing: VSpacing.sm) {
                        ProgressView()
                            .controlSize(.small)
                            .progressViewStyle(.circular)
                        Text(isActivatingManagedAssistant ? "Loading your assistant..." : "Logging in...")
                            .font(VFont.titleSmall)
                            .foregroundStyle(VColor.contentSecondary)
                    }
                    .frame(height: 36)
                } else {
                    VButton(label: primaryActionTitle, style: .primary, isFullWidth: true) {
                        Task {
                            await handlePrimaryAction()
                        }
                    }
                }

                if let error = authManager.errorMessage {
                    Text(error)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.systemNegativeStrong)
                        .multilineTextAlignment(.center)
                }

                if hasNonManagedAssistant {
                    VButton(label: "Skip", style: .ghost) {
                        if let nonManaged = LockfileAssistant.loadAll().first(where: { !$0.isManaged }) {
                            LockfileAssistant.setActiveAssistantId(nonManaged.assistantId)
                        }
                        didComplete = true
                        onComplete()
                    }
                }
            }
            .frame(maxWidth: 280)

            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            RadialGradient(
                colors: [VColor.surfaceBase, VColor.surfaceOverlay],
                center: .center,
                startRadius: 0,
                endRadius: 500
            )
            .ignoresSafeArea()
        )
        .opacity(showContent ? 1 : 0)
        .onAppear {
            withAnimation(.easeOut(duration: 0.4)) {
                showContent = true
            }
        }
        .task {
            hasNonManagedAssistant = LockfileAssistant.loadAll().contains { !$0.isManaged }

            // If already authenticated (e.g. macOS state restoration), skip
            // straight to managed assistant activation. No redundant checkSession()
            // — callers (startAuthenticatedFlow, performLogout) have already
            // resolved the auth state before presenting this view.
            if authManager.isAuthenticated && !didComplete {
                await routeAuthenticatedUser()
            }
        }
        .onChange(of: authManager.isAuthenticated) { _, isAuthenticated in
            if isAuthenticated && !didComplete {
                Task {
                    await routeAuthenticatedUser()
                }
            }
        }
    }

    @MainActor
    private var primaryActionTitle: String {
        shouldShowActivationRetry ? "Try Again" : "Log In"
    }

    private var shouldShowActivationRetry: Bool {
        authManager.isAuthenticated && authManager.errorMessage != nil
    }

    @MainActor
    private func handlePrimaryAction() async {
        if shouldShowActivationRetry {
            await completeManagedActivation()
        } else {
            await handleLoginTap()
        }
    }

    @MainActor
    private func handleLoginTap() async {
        await authManager.startWorkOSLogin()
        if authManager.isAuthenticated {
            await routeAuthenticatedUser()
        }
    }

    /// Route through `ReturningUserRouter` so this view and
    /// `AppDelegate+AuthLifecycle` share one post-auth decision path.
    ///
    /// Always takes the async path (no fast-path). `ReauthView` is only
    /// shown when the lockfile already has a managed current-env entry,
    /// so `decideFast()` would always return `.autoConnect` — consulting
    /// the platform is the whole point of routing on re-auth (it catches
    /// stale lockfile entries where the platform has 0 assistants).
    @MainActor
    private func routeAuthenticatedUser() async {
        guard !didComplete else { return }
        let router = ReturningUserRouter()
        do {
            let decision = try await router.route()
            guard !didComplete else { return }
            log.info("ReauthView router decision=\(String(describing: decision), privacy: .public)")
            switch decision {
            case .autoConnect:
                await completeManagedActivation()
            case .showHostingPicker:
                if let onNeedsHostingPicker {
                    log.info("ReauthView → showHostingPicker")
                    didComplete = true
                    onNeedsHostingPicker()
                } else {
                    // No callback wired — fall back to the old behavior
                    // so the re-auth flow still terminates.
                    log.info("ReauthView → showHostingPicker but no callback — falling back to managed activation")
                    await completeManagedActivation()
                }
            }
        } catch {
            // CancellationError — view was torn down, nothing to do.
            log.info("ReauthView router cancelled")
        }
    }

    @MainActor
    private func completeManagedActivation() async {
        guard !didComplete, !isActivatingManagedAssistant else { return }

        isActivatingManagedAssistant = true
        authManager.errorMessage = nil
        defer { isActivatingManagedAssistant = false }

        do {
            let activation = try await ManagedAssistantConnectionCoordinator().activateManagedAssistantAfterReauth()
            didComplete = true
            log.info("User re-authenticated — loading managed assistant \(activation.assistant.id, privacy: .public)")
            onComplete()
        } catch {
            authManager.errorMessage = error.localizedDescription
            log.error("Managed assistant activation after reauth failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}

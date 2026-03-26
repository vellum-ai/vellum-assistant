import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ReauthView")

@MainActor
struct ReauthView: View {
    @Bindable var authManager: AuthManager
    var onComplete: () -> Void

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
                            UserDefaults.standard.set(nonManaged.assistantId, forKey: "connectedAssistantId")
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
                await completeManagedActivation()
            }
        }
        .onChange(of: authManager.isAuthenticated) { _, isAuthenticated in
            if isAuthenticated && !didComplete {
                Task {
                    await completeManagedActivation()
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
            await completeManagedActivation()
        }
    }

    @MainActor
    private func completeManagedActivation() async {
        guard !didComplete, !isActivatingManagedAssistant else { return }

        isActivatingManagedAssistant = true
        authManager.errorMessage = nil
        defer { isActivatingManagedAssistant = false }

        // Seed AuthService with the platform URL from the existing lockfile entry
        // so that organization resolution hits the correct platform (e.g. dev-platform
        // vs production) before the daemon is connected.
        if let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId"),
           let managedAssistant = LockfileAssistant.loadByName(connectedId),
           managedAssistant.isManaged,
           let runtimeUrl = managedAssistant.runtimeUrl, !runtimeUrl.isEmpty {
            AuthService.shared.configuredBaseURL = runtimeUrl
        } else if let managedAssistant = LockfileAssistant.loadAll().first(where: { $0.isManaged }),
                  let runtimeUrl = managedAssistant.runtimeUrl, !runtimeUrl.isEmpty {
            AuthService.shared.configuredBaseURL = runtimeUrl
        }

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

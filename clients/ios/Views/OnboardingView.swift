#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// Onboarding step identifiers. The iOS MVP uses a cloud-only flow:
//   Welcome → Login → Permissions → Ready
private enum OnboardingStep: Hashable {
    case welcome
    case login
    case permissions
    case ready
}

struct OnboardingView: View {
    @Binding var isCompleted: Bool
    @Bindable var authManager: AuthManager
    @EnvironmentObject var clientProvider: ClientProvider
    @State private var currentStep: OnboardingStep = .welcome
    @State private var isBootstrappingManaged = false
    @State private var managedBootstrapError: String?

    var body: some View {
        ZStack {
            if isBootstrappingManaged {
                managedBootstrapView
                    .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
            } else {
                switch currentStep {
                case .welcome:
                    WelcomeStep(onContinue: { currentStep = .login })
                        .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
                case .login:
                    LoginView(
                        authManager: authManager,
                        onContinue: {
                            Task { await performManagedBootstrap() }
                        },
                        onCancel: { currentStep = .welcome }
                    )
                    .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
                case .permissions:
                    PermissionsStep(onContinue: { currentStep = .ready })
                        .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
                case .ready:
                    ReadyStep(isCompleted: $isCompleted)
                        .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
                }
            }
        }
        .animation(.easeInOut, value: currentStep)
        .animation(.easeInOut, value: isBootstrappingManaged)
    }

    // MARK: - Managed Bootstrap

    @ViewBuilder
    private var managedBootstrapView: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            if managedBootstrapError == nil {
                ProgressView()
                    .controlSize(.large)
                Text("Setting up your assistant...")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
            } else {
                VIconView(.triangleAlert, size: 48)
                    .foregroundStyle(VColor.systemNegativeStrong)

                Text("Setup Failed")
                    .font(VFont.titleMedium)
                    .foregroundStyle(VColor.contentDefault)

                if let error = managedBootstrapError {
                    Text(error)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, VSpacing.xl)
                }

                Button("Try Again") {
                    Task { await performManagedBootstrap() }
                }
                .buttonStyle(.borderedProminent)

                Button("Cancel") {
                    isBootstrappingManaged = false
                    managedBootstrapError = nil
                    currentStep = .login
                }
                .foregroundStyle(VColor.contentSecondary)
            }

            Spacer()
        }
        .padding(VSpacing.xl)
    }

    /// Persist the selected assistant's config, rebuild the daemon client,
    /// and advance to the permissions step.
    private func finalizeAssistantSelection(_ assistant: PlatformAssistant) {
        let platformBaseURL = VellumEnvironment.resolvedPlatformURL

        // Persist managed assistant config so GatewayHTTPClient.resolveConnection()
        // can build a ConnectionInfo for outbound requests.
        UserDefaults.standard.set(assistant.id, forKey: UserDefaultsKeys.managedAssistantId)
        UserDefaults.standard.set(platformBaseURL, forKey: UserDefaultsKeys.managedPlatformBaseURL)

        // Rebuild the daemon client with managed transport config.
        // ContentView.attemptInitialConnection() handles connecting with
        // proper retries and timeout once onboarding completes.
        clientProvider.rebuildClient()

        isBootstrappingManaged = false
        currentStep = .permissions
    }

    private func performManagedBootstrap() async {
        isBootstrappingManaged = true
        managedBootstrapError = nil

        do {
            let orgId = try await AuthService.shared.resolveOrganizationId()
            let activeResult = try await AuthService.shared.getActiveAssistant(organizationId: orgId)
            if case .found(let existing) = activeResult {
                finalizeAssistantSelection(existing)
                return
            }

            let outcome = try await ManagedAssistantBootstrapService.shared.ensureManagedAssistant()

            let assistant: PlatformAssistant
            switch outcome {
            case .reusedExisting(let existing):
                assistant = existing
            case .createdNew(let created):
                assistant = created
            }

            finalizeAssistantSelection(assistant)
        } catch {
            managedBootstrapError = error.localizedDescription
        }
    }
}

// MARK: - WelcomeStep

struct WelcomeStep: View {
    var onContinue: () -> Void

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("✨")
                .font(VFont.onboardingEmoji)

            Text("Welcome to Vellum Assistant")
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentDefault)
                .multilineTextAlignment(.center)

            Text("AI-powered assistant for your iPhone")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .multilineTextAlignment(.center)

            Spacer()

            Button("Get Started", action: onContinue)
                .buttonStyle(.borderedProminent)
                .padding(.bottom, VSpacing.xxl)
        }
        .padding(VSpacing.xl)
    }
}

// MARK: - PermissionsStep

struct PermissionsStep: View {
    var onContinue: (() -> Void)?

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("Permissions")
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentDefault)

            Text("Grant permissions for voice input")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .multilineTextAlignment(.center)

            VStack(spacing: VSpacing.lg) {
                PermissionRowView(permission: .microphone)
                PermissionRowView(
                    permission: .speechRecognition,
                    subtitle: STTProviderRegistry.isServiceConfigured ? "(Optional)" : nil
                )
            }
            .padding(VSpacing.xl)
            .background(VColor.surfaceBase)
            .cornerRadius(VRadius.md)

            Spacer()

            Button("Continue", action: { onContinue?() })
                .buttonStyle(.borderedProminent)
                .padding(.bottom, VSpacing.xxl)
        }
        .padding(VSpacing.xl)
    }
}

// MARK: - ReadyStep

struct ReadyStep: View {
    @Binding var isCompleted: Bool

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("You're All Set!")
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentDefault)

            Text("Start chatting with your AI assistant")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .multilineTextAlignment(.center)

            Button("Get Started") {
                isCompleted = true
            }
            .buttonStyle(.borderedProminent)

            Spacer()
        }
        .padding(VSpacing.xl)
    }
}
#endif

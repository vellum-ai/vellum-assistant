#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// Onboarding step identifiers for the cloud-login flow:
//   Welcome → Login → Ready
private enum OnboardingStep: Hashable {
    case welcome
    case login
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
                    currentStep = .welcome
                }
                .foregroundStyle(VColor.contentSecondary)
            }

            Spacer()
        }
        .padding(VSpacing.xl)
    }

    private func performManagedBootstrap() async {
        isBootstrappingManaged = true
        managedBootstrapError = nil

        let reconciler = ManagedAssistantIOSReconciler(
            rebuildClient: { [clientProvider] in
                clientProvider.rebuildClient()
            }
        )

        do {
            // The post-authentication hook in `AppDelegate` already drives the
            // reconciler on every successful login, so on the happy path this
            // call short-circuits against the keys the hook just wrote. When
            // the hook fails (e.g. transient platform error) the keys are
            // still absent and this retry runs the bootstrap with the visible
            // "Setting up your assistant..." spinner.
            _ = try await reconciler.reconcile()
            isBootstrappingManaged = false
            currentStep = .ready
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

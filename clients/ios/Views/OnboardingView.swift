#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// Onboarding step identifiers for the cloud-login flow:
//   Login → (managed bootstrap) → Ready
private enum OnboardingStep: Hashable {
    case login
    case ready
}

struct OnboardingView: View {
    @Binding var isCompleted: Bool
    @Bindable var authManager: AuthManager
    @EnvironmentObject var clientProvider: ClientProvider
    /// When true, the flow is being re-shown from Developer settings for visual
    /// review. The login step advances without re-running WorkOS auth and a
    /// Cancel button is exposed so the dev can exit mid-flow. No persisted
    /// state (tokens, assistant config, onboarding_completed) is touched.
    var isReplay: Bool = false
    @State private var currentStep: OnboardingStep = .login
    @State private var isBootstrappingManaged = false
    @State private var managedBootstrapError: String?

    var body: some View {
        // The strip is the last child of a root VStack and the VStack ignores
        // the bottom safe area, so the image's bottom edge sits at the
        // physical screen bottom and bleeds under the home indicator.
        // Earlier attempts using .safeAreaInset + .ignoresSafeArea on the art
        // failed because .aspectRatio(.fit) centers the rendered image inside
        // any extended frame — the VStack-last-child pattern is the reliable
        // one here.
        VStack(spacing: 0) {
            ZStack {
                if isBootstrappingManaged {
                    managedBootstrapView
                        .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
                } else {
                    switch currentStep {
                    case .login:
                        LoginView(
                            authManager: authManager,
                            isReplay: isReplay,
                            onContinue: {
                                if isReplay {
                                    // Skip bootstrap in replay — the user is already
                                    // authenticated and we must not mutate state.
                                    currentStep = .ready
                                } else {
                                    Task { await performManagedBootstrap() }
                                }
                            }
                        )
                        .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
                    case .ready:
                        ReadyStep(isCompleted: $isCompleted, isReplay: isReplay)
                            .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            OnboardingBottomStrip()
        }
        .ignoresSafeArea(.container, edges: .bottom)
        .overlay(alignment: .topLeading) {
            // Scope the cancel affordance to an overlay so the step ZStack's
            // default center alignment is preserved for ReadyStep and
            // managedBootstrapView (bare VStacks that would otherwise render
            // top-leading).
            if isReplay {
                Button("Cancel") {
                    isCompleted = true
                }
                .font(VFont.bodyLargeDefault)
                .foregroundStyle(VColor.contentSecondary)
                .padding(.horizontal, VSpacing.lg)
                .padding(.top, VSpacing.sm)
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

// MARK: - ReadyStep

struct ReadyStep: View {
    @Binding var isCompleted: Bool
    /// When true, the step was reached via the developer replay tool rather
    /// than a real login; a muted indicator is shown so it is obvious this
    /// is a dev-tool shortcut and not a fresh onboarding completion.
    var isReplay: Bool = false

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

            if isReplay {
                Text("(Developer replay — login was skipped)")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDisabled)
                    .multilineTextAlignment(.center)
            }

            Spacer()
        }
        .padding(VSpacing.xl)
    }
}
#endif

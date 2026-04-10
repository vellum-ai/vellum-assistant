#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// Onboarding step identifiers. The path branches at ChoosePath:
//   Welcome → ChoosePath → (LoginView | AssistantPicker | DaemonSetup) → Permissions → Ready
private enum OnboardingStep: Hashable {
    case welcome
    case choosePath
    case login
    case assistantPicker
    case daemonSetup
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
                    WelcomeStep(onContinue: { currentStep = .choosePath })
                        .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
                case .choosePath:
                    ChoosePathStep(
                        onLoginWithVellum: { currentStep = .login },
                        onConnectToMac: { currentStep = .daemonSetup }
                    )
                    .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
                case .login:
                    LoginView(
                        authManager: authManager,
                        onContinue: { currentStep = .assistantPicker },
                        onCancel: { currentStep = .choosePath }
                    )
                    .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
                case .assistantPicker:
                    AssistantPickerStep(
                        onSelected: { assistant in
                            connectToAssistant(assistant)
                        },
                        onHatchNew: {
                            Task { await performManagedBootstrap() }
                        },
                        onCancel: { currentStep = .choosePath }
                    )
                    .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
                case .daemonSetup:
                    DaemonSetupStep(onContinue: { currentStep = .permissions })
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
                    currentStep = .choosePath
                }
                .foregroundStyle(VColor.contentSecondary)
            }

            Spacer()
        }
        .padding(VSpacing.xl)
    }

    private func connectToAssistant(_ assistant: PlatformAssistant) {
        let platformBaseURL = AuthService.shared.baseURL

        UserDefaults.standard.set(assistant.id, forKey: UserDefaultsKeys.managedAssistantId)
        UserDefaults.standard.set(platformBaseURL, forKey: UserDefaultsKeys.managedPlatformBaseURL)
        UserDefaults.standard.set(assistant.id, forKey: "connectedAssistantId")

        clientProvider.rebuildClient()
        currentStep = .permissions
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

            let platformBaseURL = AuthService.shared.baseURL

            // Persist managed assistant config so DaemonConfig.fromUserDefaults() picks it up.
            UserDefaults.standard.set(assistant.id, forKey: UserDefaultsKeys.managedAssistantId)
            UserDefaults.standard.set(platformBaseURL, forKey: UserDefaultsKeys.managedPlatformBaseURL)
            // TODO: Migrate to LockfileAssistant.setActiveAssistantId() when
            // LockfileAssistant is available on iOS (currently macOS-only).
            UserDefaults.standard.set(assistant.id, forKey: "connectedAssistantId")

            // Rebuild the daemon client with managed transport config.
            // ContentView.attemptInitialConnection() handles connecting with
            // proper retries and timeout once onboarding completes.
            clientProvider.rebuildClient()

            isBootstrappingManaged = false
            currentStep = .permissions
        } catch {
            managedBootstrapError = error.localizedDescription
        }
    }
}

// MARK: - AssistantPickerStep

struct AssistantPickerStep: View {
    var onSelected: (PlatformAssistant) -> Void
    var onHatchNew: () -> Void
    var onCancel: () -> Void

    @State private var assistants: [PlatformAssistant] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("Choose an Assistant")
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentDefault)
                .multilineTextAlignment(.center)

            if isLoading {
                ProgressView()
                    .controlSize(.large)
                Text("Loading assistants...")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
            } else if let error = errorMessage {
                VIconView(.triangleAlert, size: 48)
                    .foregroundStyle(VColor.systemNegativeStrong)
                Text(error)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, VSpacing.xl)
                Button("Try Again") {
                    Task { await loadAssistants() }
                }
                .buttonStyle(.borderedProminent)
            } else {
                Text("Select an existing assistant or create a new one")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
                    .multilineTextAlignment(.center)

                VStack(spacing: VSpacing.md) {
                    ForEach(assistants, id: \.id) { assistant in
                        Button(action: { onSelected(assistant) }) {
                            HStack {
                                VStack(alignment: .leading, spacing: VSpacing.xs) {
                                    Text(assistant.name ?? "Unnamed Assistant")
                                        .font(VFont.bodyMediumEmphasised)
                                        .foregroundStyle(VColor.contentDefault)
                                    Text(assistant.id)
                                        .font(VFont.labelDefault)
                                        .foregroundStyle(VColor.contentSecondary)
                                        .lineLimit(1)
                                }
                                Spacer()
                                if let status = assistant.status {
                                    Text(status)
                                        .font(VFont.labelDefault)
                                        .foregroundStyle(status == "active" ? VColor.systemPositiveStrong : VColor.contentSecondary)
                                }
                            }
                            .padding(VSpacing.lg)
                            .background(VColor.surfaceBase)
                            .cornerRadius(VRadius.md)
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.md)
                                    .stroke(VColor.borderBase, lineWidth: 1)
                            )
                        }
                    }

                    Button(action: onHatchNew) {
                        HStack {
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Create New Assistant")
                                    .font(VFont.bodyMediumEmphasised)
                                    .foregroundStyle(VColor.contentDefault)
                                Text("Set up a new cloud assistant")
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentSecondary)
                            }
                            Spacer()
                            VIconView(.plus, size: 20)
                                .foregroundStyle(VColor.primaryBase)
                        }
                        .padding(VSpacing.lg)
                        .background(VColor.surfaceBase)
                        .cornerRadius(VRadius.md)
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .stroke(VColor.borderBase, lineWidth: 1)
                        )
                    }
                }
                .padding(.horizontal, VSpacing.xl)
            }

            Spacer()

            Button("Cancel") { onCancel() }
                .foregroundStyle(VColor.contentSecondary)
                .padding(.bottom, VSpacing.xxl)
        }
        .padding(VSpacing.xl)
        .task { await loadAssistants() }
    }

    private func loadAssistants() async {
        isLoading = true
        errorMessage = nil

        do {
            // Ensure the org ID is resolved and persisted before listing.
            _ = try await AuthService.shared.resolveOrganizationId()
            let list = try await AuthService.shared.listAssistants()
            assistants = list
            isLoading = false

            // If no existing assistants, go straight to hatch
            if list.isEmpty {
                onHatchNew()
            }
        } catch {
            errorMessage = error.localizedDescription
            isLoading = false
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

// MARK: - ChoosePathStep

struct ChoosePathStep: View {
    var onLoginWithVellum: () -> Void
    var onConnectToMac: () -> Void

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("How would you like to connect?")
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentDefault)
                .multilineTextAlignment(.center)

            VStack(spacing: VSpacing.lg) {
                Button(action: onLoginWithVellum) {
                    HStack {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Log in with Vellum")
                                .font(VFont.bodyMediumEmphasised)
                                .foregroundStyle(VColor.contentDefault)
                            Text("Connect to your cloud assistant")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentSecondary)
                        }
                        Spacer()
                        VIconView(.cloud, size: 20)
                            .foregroundStyle(VColor.primaryBase)
                    }
                    .padding(VSpacing.lg)
                    .background(VColor.surfaceBase)
                    .cornerRadius(VRadius.md)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                }

                Button(action: onConnectToMac) {
                    HStack {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Connect to Assistant")
                                .font(VFont.bodyMediumEmphasised)
                                .foregroundStyle(VColor.contentDefault)
                            Text("Connect via your local network")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentSecondary)
                        }
                        Spacer()
                        VIconView(.monitor, size: 20)
                            .foregroundStyle(VColor.primaryBase)
                    }
                    .padding(VSpacing.lg)
                    .background(VColor.surfaceBase)
                    .cornerRadius(VRadius.md)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                }
            }
            .padding(.horizontal, VSpacing.xl)

            Spacer()
        }
        .padding(VSpacing.xl)
    }
}

// MARK: - DaemonSetupStep

struct DaemonSetupStep: View {
    var onContinue: (() -> Void)?
    @State private var showingQRPairing = false
    @State private var isPaired = false

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Spacer()

            Text("Connect to Assistant")
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentDefault)

            Text("Scan the QR code from your Assistant to pair.")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)

            // QR Scanner button
            Button {
                showingQRPairing = true
            } label: {
                HStack(spacing: VSpacing.md) {
                    VIconView(.qrCode, size: 24)
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text("Scan QR Code")
                            .font(VFont.bodyMediumEmphasised)
                        Text("Open Vellum on your Assistant \u{2192} Settings \u{2192} Show QR Code")
                            .font(VFont.labelDefault)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.lg)
                .background(VColor.surfaceBase)
                .cornerRadius(VRadius.md)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.borderBase, lineWidth: 1)
                )
            }
            .foregroundStyle(VColor.contentDefault)
            .padding(.horizontal, VSpacing.xl)

            Button("Continue") {
                onContinue?()
            }
            .buttonStyle(.borderedProminent)
            .disabled(!isPaired)

            Button("Skip for now") {
                onContinue?()
            }
            .foregroundStyle(VColor.contentSecondary)

            Spacer()
        }
        .padding(VSpacing.xl)
        .sheet(isPresented: $showingQRPairing, onDismiss: {
            checkPairingState()
        }) {
            QRPairingSheet()
        }
        .onAppear {
            checkPairingState()
        }
    }

    private func checkPairingState() {
        let gatewayURL = UserDefaults.standard.string(forKey: UserDefaultsKeys.gatewayBaseURL) ?? ""
        let bearerToken = APIKeyManager.shared.getAPIKey(provider: "runtime-bearer-token") ?? ""
        isPaired = !gatewayURL.isEmpty && !bearerToken.isEmpty
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
                PermissionRowView(permission: .speechRecognition)
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

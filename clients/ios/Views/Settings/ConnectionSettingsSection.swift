#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// MARK: - Standalone API Key Section

struct APIKeySection: View {
    @State private var apiKey: String = ""
    @State private var showingAlert = false
    @State private var alertTitle = ""
    @State private var alertMessage = ""

    var body: some View {
        Section("Anthropic API Key") {
            SecureField("Anthropic API Key", text: $apiKey)
                .textContentType(.password)
                .autocapitalization(.none)

            Button("Save") {
                let success = APIKeyManager.shared.setAPIKey(apiKey)
                if success {
                    alertTitle = "Success"
                    alertMessage = "API Key saved securely"
                } else {
                    alertTitle = "Error"
                    alertMessage = "Failed to save API Key to Keychain"
                }
                showingAlert = true
            }
            .disabled(apiKey.isEmpty)
            Text("Your API key is stored locally and never sent to Vellum servers.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .alert(alertTitle, isPresented: $showingAlert) {
            Button("OK") {}
        } message: {
            Text(alertMessage)
        }
        .onAppear {
            apiKey = APIKeyManager.shared.getAPIKey() ?? ""
        }
    }
}

// MARK: - Connected Assistant Section

struct DaemonConnectionSection: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @Bindable var authManager: AuthManager

    /// The currently configured gateway URL, shown as read-only status.
    private var gatewayURL: String? {
        UserDefaults.standard.string(forKey: UserDefaultsKeys.gatewayBaseURL).flatMap { $0.isEmpty ? nil : $0 }
    }

    var body: some View {
        Form {
            // Connection status section — always visible
            Section {
                if let url = gatewayURL {
                    if clientProvider.isConnected {
                        // Connected state
                        HStack {
                            VIconView(.circleCheck, size: 16)
                                .foregroundStyle(VColor.systemPositiveStrong)
                            Text("Connected")
                                .font(VFont.bodyMediumLighter)
                                .foregroundStyle(VColor.contentDefault)
                        }
                    } else {
                        // Disconnected state — gateway configured but not connected
                        HStack {
                            VIconView(.circleAlert, size: 16)
                                .foregroundStyle(VColor.systemNegativeStrong)
                            Text("Disconnected")
                                .font(VFont.bodyMediumLighter)
                                .foregroundStyle(VColor.contentDefault)
                        }
                    }
                    HStack {
                        Text("Gateway")
                            .foregroundStyle(VColor.contentSecondary)
                        Spacer()
                        Text(url)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentTertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                } else {
                    // Not configured state
                    Text("Sign in with your Vellum account to connect.")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                }
            } header: {
                Text("Connection")
            }

            // MARK: - Vellum Account

            Section {
                if authManager.isLoading {
                    HStack {
                        Text("Checking session...")
                        Spacer()
                        ProgressView()
                    }
                } else if let user = authManager.currentUser {
                    if let email = user.email {
                        LabeledContent("Email", value: email)
                    }
                    if let display = user.display {
                        LabeledContent("Name", value: display)
                    }
                    Button("Log Out", role: .destructive) {
                        Task {
                            await authManager.logout()
                        }
                    }
                } else {
                    Button {
                        Task { await authManager.startWorkOSLogin() }
                    } label: {
                        if authManager.isSubmitting {
                            HStack {
                                Text("Signing in...")
                                Spacer()
                                ProgressView()
                            }
                        } else {
                            Text("Log in with Vellum")
                        }
                    }
                    .disabled(authManager.isSubmitting)
                }

                if let error = authManager.errorMessage {
                    Text(error)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.systemNegativeStrong)
                }
                } header: {
                    Text("Vellum Account")
                } footer: {
                    if !authManager.isAuthenticated {
                        Text("Sign in to connect to your cloud assistant.")
                    }
                }

        }
        .navigationTitle("Connect")
        .navigationBarTitleDisplayMode(.inline)
    }
}
#endif

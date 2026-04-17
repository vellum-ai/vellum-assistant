#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct DaemonConnectionSection: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @Bindable var authManager: AuthManager

    /// The currently configured platform base URL for the managed cloud assistant,
    /// written during onboarding's managed bootstrap. Shown as read-only status.
    /// Absent until a user completes `performManagedBootstrap`.
    private var managedPlatformURL: String? {
        UserDefaults.standard.string(forKey: UserDefaultsKeys.managedPlatformBaseURL)
            .flatMap { $0.isEmpty ? nil : $0 }
    }

    var body: some View {
        Form {
            // Connection status section — always visible
            Section {
                if let url = managedPlatformURL {
                    if clientProvider.isConnected {
                        HStack {
                            VIconView(.circleCheck, size: 16)
                                .foregroundStyle(VColor.systemPositiveStrong)
                            Text("Connected")
                                .font(VFont.bodyMediumLighter)
                                .foregroundStyle(VColor.contentDefault)
                        }
                    } else {
                        HStack {
                            VIconView(.circleAlert, size: 16)
                                .foregroundStyle(VColor.systemNegativeStrong)
                            Text("Disconnected")
                                .font(VFont.bodyMediumLighter)
                                .foregroundStyle(VColor.contentDefault)
                        }
                    }
                    HStack {
                        Text("Platform")
                            .foregroundStyle(VColor.contentSecondary)
                        Spacer()
                        Text(url)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentTertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                } else {
                    // Managed bootstrap has not run yet — user must sign in.
                    Text("Log in with Vellum to connect to your cloud assistant.")
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

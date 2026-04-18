#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct DaemonConnectionSection: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @Bindable var authManager: AuthManager

    /// Describes which UserDefaults key populated the current connection, so the
    /// status row can label the URL appropriately. Mirrors the branches of
    /// `GatewayHTTPClient.resolveConnection()` on iOS.
    private enum ConnectionSource {
        case managedPlatform
        case gateway
    }

    /// The URL and source backing the current iOS connection, resolved in the
    /// same priority order as `GatewayHTTPClient.resolveConnection()`:
    /// managed platform first, then legacy `gateway_base_url` as a fallback.
    private var resolvedConnection: (url: String, source: ConnectionSource)? {
        let defaults = UserDefaults.standard
        if let managedId = defaults.string(forKey: UserDefaultsKeys.managedAssistantId),
           !managedId.isEmpty,
           let platformURL = defaults.string(forKey: UserDefaultsKeys.managedPlatformBaseURL),
           !platformURL.isEmpty {
            return (platformURL, .managedPlatform)
        }
        if let gatewayURL = defaults.string(forKey: UserDefaultsKeys.gatewayBaseURL),
           !gatewayURL.isEmpty {
            return (gatewayURL, .gateway)
        }
        return nil
    }

    var body: some View {
        Form {
            // Connection status section — always visible
            Section {
                if let connection = resolvedConnection {
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
                        Text(connection.source == .managedPlatform ? "Platform" : "Gateway")
                            .foregroundStyle(VColor.contentSecondary)
                        Spacer()
                        Text(connection.url)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentTertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                } else {
                    // No managed bootstrap and no legacy gateway URL on disk.
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

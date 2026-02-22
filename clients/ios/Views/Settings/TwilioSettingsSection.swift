#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct TwilioSettingsSection: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @State private var hasCredentials = false
    @State private var phoneNumber: String?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var isClearing = false
    @State private var showClearConfirmation = false

    var body: some View {
        Section("Twilio (Calls & SMS)") {
            if isLoading {
                HStack {
                    Text("Loading...")
                    Spacer()
                    ProgressView()
                        .controlSize(.small)
                }
            } else {
                // Connection status
                HStack {
                    Text("Credentials")
                    Spacer()
                    if hasCredentials {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(VColor.success)
                        Text("Connected")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Image(systemName: "xmark.circle")
                            .foregroundColor(VColor.error)
                        Text("Not configured")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                // Phone number
                HStack {
                    Text("Phone Number")
                    Spacer()
                    if let number = phoneNumber {
                        Text(number)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("None assigned")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                // Actions
                if hasCredentials {
                    Button(role: .destructive) {
                        showClearConfirmation = true
                    } label: {
                        HStack {
                            if isClearing {
                                ProgressView()
                                    .controlSize(.small)
                                Text("Clearing...")
                            } else {
                                Text("Clear Credentials")
                            }
                        }
                    }
                    .disabled(isClearing)
                } else {
                    Text("Use the Twilio Setup skill in chat to configure credentials and phone number.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let error = errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundColor(VColor.error)
                }
            }
        }
        .confirmationDialog("Clear Twilio Credentials", isPresented: $showClearConfirmation, titleVisibility: .visible) {
            Button("Clear", role: .destructive) {
                clearCredentials()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will remove your Twilio Account SID and Auth Token. Your phone number assignment will be preserved. Voice calls and SMS will stop working until credentials are reconfigured.")
        }
        .onAppear { loadStatus() }
        .onChange(of: clientProvider.isConnected) { _, connected in
            if connected { loadStatus() }
        }
        .onDisappear {
            if let daemon = clientProvider.client as? DaemonClient {
                daemon.onTwilioConfigResponse = nil
            }
        }
    }

    private func loadStatus() {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        isLoading = true
        errorMessage = nil

        daemon.onTwilioConfigResponse = { response in
            isLoading = false
            isClearing = false
            if response.success {
                hasCredentials = response.hasCredentials
                phoneNumber = response.phoneNumber
                errorMessage = nil
            } else {
                errorMessage = response.error ?? "Failed to load Twilio status"
            }
        }

        do {
            try daemon.sendTwilioConfig(action: "get")
        } catch {
            isLoading = false
            errorMessage = "Failed to connect to daemon"
        }
    }

    private func clearCredentials() {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        isClearing = true
        errorMessage = nil

        do {
            try daemon.sendTwilioConfig(action: "clear_credentials")
        } catch {
            isClearing = false
            errorMessage = "Failed to send clear request"
        }
    }
}
#endif

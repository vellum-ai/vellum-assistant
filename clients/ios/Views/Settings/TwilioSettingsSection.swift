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

    // Number lifecycle state
    @State private var availableNumbers: [TwilioNumberInfo] = []
    @State private var isLoadingNumbers = false
    @State private var showProvisionSheet = false
    @State private var provisionCountry = "US"
    @State private var provisionAreaCode = ""
    @State private var isProvisioning = false
    @State private var isAssigning = false
    @State private var assigningNumber: String?

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

                // Actions when credentials are configured
                if hasCredentials {
                    // List available numbers
                    Button {
                        listNumbers()
                    } label: {
                        HStack {
                            Text("List Account Numbers")
                            Spacer()
                            if isLoadingNumbers {
                                ProgressView()
                                    .controlSize(.small)
                            } else {
                                Image(systemName: "phone.badge.waveform")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .disabled(isLoadingNumbers)

                    // Show available numbers for assignment
                    if !availableNumbers.isEmpty {
                        ForEach(availableNumbers, id: \.phoneNumber) { number in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(number.phoneNumber)
                                        .font(.body)
                                    HStack(spacing: 4) {
                                        Text(number.friendlyName)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                        if number.capabilities.voice {
                                            Text("Voice")
                                                .font(.caption2)
                                                .padding(.horizontal, 4)
                                                .padding(.vertical, 1)
                                                .background(Color.blue.opacity(0.15))
                                                .cornerRadius(4)
                                        }
                                        if number.capabilities.sms {
                                            Text("SMS")
                                                .font(.caption2)
                                                .padding(.horizontal, 4)
                                                .padding(.vertical, 1)
                                                .background(Color.green.opacity(0.15))
                                                .cornerRadius(4)
                                        }
                                    }
                                }
                                Spacer()
                                if number.phoneNumber == phoneNumber {
                                    Text("Active")
                                        .font(.caption)
                                        .foregroundColor(VColor.success)
                                } else if assigningNumber == number.phoneNumber {
                                    ProgressView()
                                        .controlSize(.small)
                                } else {
                                    Button("Assign") {
                                        assignNumber(number.phoneNumber)
                                    }
                                    .font(.caption)
                                    .disabled(isAssigning)
                                }
                            }
                        }
                    }

                    // Provision new number
                    Button {
                        showProvisionSheet = true
                    } label: {
                        HStack {
                            Text("Provision New Number")
                            Spacer()
                            Image(systemName: "plus.circle")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .disabled(isProvisioning)

                    // Clear credentials
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
        .sheet(isPresented: $showProvisionSheet) {
            provisionSheet
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

    // MARK: - Provision Sheet

    @ViewBuilder
    private var provisionSheet: some View {
        NavigationStack {
            Form {
                Section("Country") {
                    TextField("Country code (e.g. US, GB)", text: $provisionCountry)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                }
                Section("Area Code (Optional)") {
                    TextField("e.g. 415", text: $provisionAreaCode)
                        .keyboardType(.numberPad)
                }
                Section {
                    Button {
                        provisionNumber()
                    } label: {
                        HStack {
                            Spacer()
                            if isProvisioning {
                                ProgressView()
                                    .controlSize(.small)
                                Text("Provisioning...")
                            } else {
                                Text("Provision Number")
                            }
                            Spacer()
                        }
                    }
                    .disabled(isProvisioning || provisionCountry.isEmpty)
                } footer: {
                    Text("This will purchase a new phone number from Twilio in the selected country. Standard Twilio pricing applies.")
                        .font(.caption)
                }
            }
            .navigationTitle("Provision Number")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showProvisionSheet = false
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: - IPC Actions

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

    /// Restores the default onTwilioConfigResponse handler (the one set by
    /// loadStatus) so that subsequent responses — such as clear_credentials —
    /// are handled correctly instead of being swallowed by a stale callback
    /// from a previous action.
    private func restoreDefaultHandler() {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
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
    }

    private func clearCredentials() {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        isClearing = true
        errorMessage = nil

        daemon.onTwilioConfigResponse = { response in
            isClearing = false
            if response.success {
                hasCredentials = response.hasCredentials
                phoneNumber = response.phoneNumber
                availableNumbers = []
                errorMessage = nil
            } else {
                errorMessage = response.error ?? "Failed to clear credentials"
            }
            restoreDefaultHandler()
        }

        do {
            try daemon.sendTwilioConfig(action: "clear_credentials")
        } catch {
            isClearing = false
            errorMessage = "Failed to send clear request"
            restoreDefaultHandler()
        }
    }

    private func listNumbers() {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        isLoadingNumbers = true
        errorMessage = nil

        daemon.onTwilioConfigResponse = { response in
            isLoadingNumbers = false
            if response.success {
                hasCredentials = response.hasCredentials
                // Don't update phoneNumber here — list_numbers responses don't
                // include a phoneNumber field, so writing it would clear the
                // currently assigned number in the UI.
                availableNumbers = response.numbers ?? []
                if availableNumbers.isEmpty {
                    errorMessage = "No numbers found on this Twilio account."
                } else {
                    errorMessage = nil
                }
            } else {
                errorMessage = response.error ?? "Failed to list numbers"
            }
            restoreDefaultHandler()
        }

        do {
            try daemon.sendTwilioConfig(action: "list_numbers")
        } catch {
            isLoadingNumbers = false
            errorMessage = "Failed to connect to daemon"
        }
    }

    private func provisionNumber() {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        isProvisioning = true
        errorMessage = nil

        daemon.onTwilioConfigResponse = { response in
            isProvisioning = false
            if response.success {
                hasCredentials = response.hasCredentials
                phoneNumber = response.phoneNumber
                showProvisionSheet = false
                provisionAreaCode = ""
                errorMessage = nil
                // Refresh the number list to include the newly provisioned number
                listNumbers()
            } else {
                // Dismiss the sheet so the error message is visible in the
                // parent section rather than hidden behind the sheet.
                showProvisionSheet = false
                errorMessage = response.error ?? "Failed to provision number"
                restoreDefaultHandler()
            }
        }

        do {
            let areaCode = provisionAreaCode.isEmpty ? nil : provisionAreaCode
            try daemon.sendTwilioConfig(
                action: "provision_number",
                areaCode: areaCode,
                country: provisionCountry
            )
        } catch {
            isProvisioning = false
            showProvisionSheet = false
            errorMessage = "Failed to connect to daemon"
        }
    }

    private func assignNumber(_ number: String) {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        isAssigning = true
        assigningNumber = number
        errorMessage = nil

        daemon.onTwilioConfigResponse = { response in
            isAssigning = false
            assigningNumber = nil
            if response.success {
                hasCredentials = response.hasCredentials
                phoneNumber = response.phoneNumber
                errorMessage = nil
            } else {
                errorMessage = response.error ?? "Failed to assign number"
            }
            restoreDefaultHandler()
        }

        do {
            try daemon.sendTwilioConfig(action: "assign_number", phoneNumber: number)
        } catch {
            isAssigning = false
            assigningNumber = nil
            errorMessage = "Failed to connect to daemon"
        }
    }
}
#endif

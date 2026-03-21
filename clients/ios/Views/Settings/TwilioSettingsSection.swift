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
        Form {
            Section {
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
                            VIconView(.circleCheck, size: 16)
                                .foregroundColor(VColor.systemPositiveStrong)
                            Text("Connected")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            VIconView(.circleX, size: 16)
                                .foregroundColor(VColor.systemNegativeStrong)
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
                                    VIconView(.phoneCall, size: 16)
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
                                        }
                                    }
                                    Spacer()
                                    if number.phoneNumber == phoneNumber {
                                        Text("Active")
                                            .font(.caption)
                                            .foregroundColor(VColor.systemPositiveStrong)
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
                                VIconView(.plus, size: 16)
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
                            .foregroundColor(VColor.systemNegativeStrong)
                    }
                }
            }
        }
        .navigationTitle("Twilio")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Clear Twilio Credentials", isPresented: $showClearConfirmation, titleVisibility: .visible) {
            Button("Clear", role: .destructive) {
                clearCredentials()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will remove your Twilio Account SID and Auth Token. Your phone number assignment will be preserved. Voice calls will stop working until credentials are reconfigured.")
        }
        .sheet(isPresented: $showProvisionSheet) {
            provisionSheet
        }
        .onAppear { loadStatus() }
        .onChange(of: clientProvider.isConnected) { _, connected in
            if connected { loadStatus() }
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

    /// Perform a Twilio HTTP request via GatewayHTTPClient and apply the response.
    private func performHTTPRequest(
        method: String,
        path: String,
        body: [String: Any]? = nil,
        applyPhoneNumber: Bool = false,
        applyNumbers: Bool = false
    ) async -> Bool {
        guard let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") else {
            errorMessage = "No connected assistant"
            return false
        }

        // Strip leading "/v1/" if present — GatewayHTTPClient prepends /v1/ automatically.
        let trimmedPath = path.hasPrefix("/v1/") ? String(path.dropFirst(4)) : path
        let gatewayPath = "assistants/\(assistantId)/\(trimmedPath)"

        let bodyData: Data?
        if let body {
            bodyData = try? JSONSerialization.data(withJSONObject: body)
        } else {
            bodyData = nil
        }

        do {
            let response: GatewayHTTPClient.Response
            switch method {
            case "GET":
                response = try await GatewayHTTPClient.get(path: gatewayPath)
            case "POST":
                response = try await GatewayHTTPClient.post(path: gatewayPath, body: bodyData)
            case "DELETE":
                response = try await GatewayHTTPClient.delete(path: gatewayPath, body: bodyData)
            default:
                errorMessage = "Unsupported HTTP method"
                return false
            }

            guard response.isSuccess else {
                let errorBody = String(data: response.data, encoding: .utf8) ?? "Request failed"
                errorMessage = errorBody
                return false
            }

            guard let json = try JSONSerialization.jsonObject(with: response.data) as? [String: Any] else {
                errorMessage = "Invalid JSON response"
                return false
            }

            let success = json["success"] as? Bool ?? false
            if success {
                hasCredentials = json["hasCredentials"] as? Bool ?? false
                if !hasCredentials {
                    phoneNumber = nil
                    availableNumbers = []
                } else {
                    if applyPhoneNumber || json["phoneNumber"] != nil {
                        phoneNumber = json["phoneNumber"] as? String
                    }
                    if applyNumbers {
                        availableNumbers = Self.decodeTwilioNumbers(from: json["numbers"])
                    } else if json["numbers"] != nil {
                        availableNumbers = Self.decodeTwilioNumbers(from: json["numbers"])
                    }
                }
                errorMessage = nil
                return true
            } else {
                errorMessage = json["error"] as? String ?? "Unknown error"
                return false
            }
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Decode the `numbers` array from the Twilio HTTP response JSON.
    private static func decodeTwilioNumbers(from raw: Any?) -> [TwilioNumberInfo] {
        guard let array = raw as? [[String: Any]] else { return [] }
        return array.compactMap { dict -> TwilioNumberInfo? in
            guard let phoneNumber = dict["phoneNumber"] as? String,
                  let friendlyName = dict["friendlyName"] as? String,
                  let caps = dict["capabilities"] as? [String: Any] else { return nil }
            let voice = caps["voice"] as? Bool ?? false
            return TwilioNumberInfo(
                phoneNumber: phoneNumber,
                friendlyName: friendlyName,
                capabilities: TwilioNumberCapabilities(voice: voice)
            )
        }
    }

    // MARK: - HTTP Actions

    private func loadStatus() {
        isLoading = true
        errorMessage = nil
        Task {
            await performHTTPRequest(
                method: "GET",
                path: "/v1/integrations/twilio/config",
                applyPhoneNumber: true
            )
            isLoading = false
        }
    }

    private func clearCredentials() {
        isClearing = true
        errorMessage = nil
        Task {
            let success = await performHTTPRequest(
                method: "DELETE",
                path: "/v1/integrations/twilio/credentials"
            )
            isClearing = false
            if success {
                availableNumbers = []
            }
        }
    }

    private func listNumbers() {
        isLoadingNumbers = true
        errorMessage = nil
        Task {
            let success = await performHTTPRequest(
                method: "GET",
                path: "/v1/integrations/twilio/numbers",
                applyNumbers: true
            )
            isLoadingNumbers = false
            if success && availableNumbers.isEmpty {
                errorMessage = "No numbers found on this Twilio account."
            }
        }
    }

    private func provisionNumber() {
        isProvisioning = true
        errorMessage = nil
        Task {
            var body: [String: Any] = [:]
            if !provisionAreaCode.isEmpty { body["areaCode"] = provisionAreaCode }
            if !provisionCountry.isEmpty { body["country"] = provisionCountry }
            let success = await performHTTPRequest(
                method: "POST",
                path: "/v1/integrations/twilio/numbers/provision",
                body: body.isEmpty ? nil : body,
                applyPhoneNumber: true
            )
            isProvisioning = false
            if success {
                showProvisionSheet = false
                provisionAreaCode = ""
                // Refresh the number list to include the newly provisioned number
                listNumbers()
            } else {
                showProvisionSheet = false
            }
        }
    }

    private func assignNumber(_ number: String) {
        isAssigning = true
        assigningNumber = number
        errorMessage = nil
        Task {
            await performHTTPRequest(
                method: "POST",
                path: "/v1/integrations/twilio/numbers/assign",
                body: ["phoneNumber": number],
                applyPhoneNumber: true
            )
            isAssigning = false
            assigningNumber = nil
        }
    }
}
#endif

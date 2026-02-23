import Foundation
import SwiftUI
import VellumAssistantShared

/// Connect settings tab — centralized Gateway URL, Bearer Token, channel configuration,
/// and QR pairing UI. This is the single source of truth for configuring how devices
/// and integrations reach this Mac.
@MainActor
struct SettingsConnectTab: View {
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?

    @State private var gatewayUrlText: String = ""
    @FocusState private var isGatewayUrlFocused: Bool
    @State private var bearerToken: String = ""
    @State private var tokenRevealed: Bool = false
    @State private var tokenCopied: Bool = false
    @State private var gatewayTargetCopied: Bool = false
    @State private var showingPairingQR: Bool = false
    @State private var showingRegenerateConfirmation: Bool = false

    // Telegram credential entry
    @State private var telegramBotTokenText = ""
    @State private var telegramSetupExpanded = false

    // Twilio credential entry
    @State private var twilioAccountSidText = ""
    @State private var twilioAuthTokenText = ""
    @State private var twilioSetupExpanded = false

    // Twilio number picker
    @State private var twilioNumberPickerExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            gatewaySection
            bearerTokenSection
            telegramCard
            twilioCard
            pairingSection
            statusSection
            testConnectionSection
        }
        .onAppear {
            store.refreshIngressConfig()
            gatewayUrlText = store.ingressPublicBaseUrl
            refreshBearerToken()
            store.refreshChannelGuardianStatus(channel: "telegram")
            store.refreshChannelGuardianStatus(channel: "sms")
        }
        .onChange(of: store.ingressPublicBaseUrl) { _, newValue in
            if !isGatewayUrlFocused {
                gatewayUrlText = newValue
            }
        }
        .onChange(of: isGatewayUrlFocused) { _, focused in
            if !focused {
                gatewayUrlText = store.ingressPublicBaseUrl
            }
        }
        .alert("Regenerate Bearer Token", isPresented: $showingRegenerateConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Regenerate", role: .destructive) {
                regenerateHttpToken()
            }
        } message: {
            Text("This will replace the current bearer token and restart the daemon. Any paired devices will need to reconnect.")
        }
        .sheet(isPresented: $showingPairingQR) {
            PairingQRCodeSheet(
                ingressEnabled: store.ingressEnabled,
                ingressPublicBaseUrl: store.ingressPublicBaseUrl
            )
        }
    }

    // MARK: - Gateway Section

    private var gatewaySection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Gateway & Pairing")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            // Gateway URL field
            HStack(spacing: VSpacing.xs) {
                Text("Gateway URL")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }

            TextField("https://your-tunnel.example.com", text: $gatewayUrlText)
                .focused($isGatewayUrlFocused)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.md)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )

            VButton(label: "Save", style: .primary) {
                store.saveIngressPublicBaseUrl(gatewayUrlText)
            }

            Divider()
                .background(VColor.surfaceBorder)

            // Local Gateway Target (read-only)
            HStack(spacing: VSpacing.xs) {
                Text("Local Gateway Target")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }

            HStack(spacing: VSpacing.sm) {
                Text(store.localGatewayTarget)
                    .font(VFont.mono)
                    .foregroundColor(VColor.textPrimary)
                    .textSelection(.enabled)
                    .padding(VSpacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(VColor.surface.opacity(0.5))
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder.opacity(0.3), lineWidth: 1)
                    )

                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(store.localGatewayTarget, forType: .string)
                    gatewayTargetCopied = true
                    Task {
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                        gatewayTargetCopied = false
                    }
                } label: {
                    Image(systemName: gatewayTargetCopied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(gatewayTargetCopied ? VColor.success : VColor.textSecondary)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy gateway address")
                .help("Copy address")
            }

            Text("Point your tunnel (ngrok, Cloudflare, etc.) to this address.")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Bearer Token Section

    private var bearerTokenSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Bearer Token")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            if bearerToken.isEmpty {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(VColor.warning)
                        .font(.system(size: 12))
                    Text("Bearer token not found. Restart the daemon to generate it.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            } else {
                HStack(spacing: VSpacing.sm) {
                    // Masked or revealed token
                    if tokenRevealed {
                        Text(bearerToken)
                            .font(VFont.mono)
                            .foregroundColor(VColor.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    } else {
                        Text(String(repeating: "\u{2022}", count: min(bearerToken.count, 24)))
                            .font(VFont.mono)
                            .foregroundColor(VColor.textPrimary)
                            .lineLimit(1)
                    }

                    Spacer()

                    // Reveal/hide toggle
                    Button {
                        tokenRevealed.toggle()
                    } label: {
                        Image(systemName: tokenRevealed ? "eye.slash" : "eye")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(VColor.textSecondary)
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(tokenRevealed ? "Hide token" : "Reveal token")
                    .help(tokenRevealed ? "Hide token" : "Reveal token")

                    // Copy button
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(bearerToken, forType: .string)
                        tokenCopied = true
                        Task {
                            try? await Task.sleep(nanoseconds: 2_000_000_000)
                            tokenCopied = false
                        }
                    } label: {
                        Image(systemName: tokenCopied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(tokenCopied ? VColor.success : VColor.textSecondary)
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Copy bearer token")
                    .help("Copy token")

                    // Regenerate button
                    Button("Regenerate") {
                        showingRegenerateConfirmation = true
                    }
                    .font(VFont.caption)
                    .foregroundColor(VColor.accent)
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Telegram Channel Card

    private var telegramCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Telegram")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Text("Message your assistant from Telegram")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }

            // Bot credential row
            if store.telegramHasBotToken {
                channelStatusRow(
                    label: "Bot",
                    icon: "checkmark.circle.fill",
                    iconColor: VColor.success,
                    value: store.telegramBotUsername.map { "@\($0)" } ?? "Configured",
                    action: .init(label: "Clear", style: .danger, disabled: store.telegramSaveInProgress) {
                        store.clearTelegramCredentials()
                        telegramBotTokenText = ""
                        telegramSetupExpanded = false
                    }
                )
            } else if telegramSetupExpanded {
                telegramCredentialEntry
            } else {
                channelStatusRow(
                    label: "Bot",
                    icon: "exclamationmark.triangle",
                    iconColor: VColor.warning,
                    value: "Not configured",
                    valueColor: VColor.textMuted,
                    action: .init(label: "Set Up", style: .secondary) {
                        telegramSetupExpanded = true
                    }
                )
            }

            if let error = store.telegramError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }

            // Guardian row (only when credentials exist)
            if store.telegramHasBotToken {
                Divider().background(VColor.surfaceBorder)
                guardianStatusRow(channel: "telegram")
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Telegram Credential Entry

    private var telegramCredentialEntry: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                Text("Bot Token")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
                VButton(label: "Cancel", style: .tertiary) {
                    telegramSetupExpanded = false
                    telegramBotTokenText = ""
                }
            }

            SecureField("Telegram bot token", text: $telegramBotTokenText)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.md)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )

            Text("Get your bot token from @BotFather on Telegram")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            if store.telegramSaveInProgress {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Saving...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            } else {
                VButton(label: "Save", style: .primary) {
                    store.saveTelegramToken(botToken: telegramBotTokenText)
                    telegramBotTokenText = ""
                    telegramSetupExpanded = false
                }
                .disabled(telegramBotTokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    // MARK: - SMS (Twilio) Channel Card

    private var twilioCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("SMS (Twilio)")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            // Credentials row
            if store.twilioHasCredentials {
                channelStatusRow(
                    label: "Credentials",
                    icon: "checkmark.circle.fill",
                    iconColor: VColor.success,
                    value: "Configured",
                    action: .init(label: "Clear", style: .danger, disabled: store.twilioSaveInProgress) {
                        store.clearTwilioCredentials()
                        twilioSetupExpanded = false
                    }
                )
            } else if twilioSetupExpanded {
                twilioCredentialEntry
            } else {
                channelStatusRow(
                    label: "Credentials",
                    icon: "exclamationmark.triangle",
                    iconColor: VColor.warning,
                    value: "Not configured",
                    valueColor: VColor.textMuted,
                    action: .init(label: "Set Up", style: .secondary) {
                        twilioSetupExpanded = true
                    }
                )
            }

            // Phone number row (only when credentials exist)
            if store.twilioHasCredentials {
                Divider().background(VColor.surfaceBorder)

                if twilioNumberPickerExpanded {
                    twilioNumberPicker
                } else {
                    channelStatusRow(
                        label: "Phone Number",
                        icon: store.twilioPhoneNumber != nil ? "phone.fill" : "phone",
                        iconColor: store.twilioPhoneNumber != nil ? VColor.success : VColor.textMuted,
                        value: store.twilioPhoneNumber ?? "Not assigned",
                        valueFont: VFont.mono,
                        valueColor: store.twilioPhoneNumber != nil ? VColor.textPrimary : VColor.textMuted,
                        action: .init(label: "Change", style: .secondary) {
                            twilioNumberPickerExpanded = true
                            if !store.twilioListInProgress {
                                store.refreshTwilioNumbers()
                            }
                        }
                    )
                }
            }

            if let warning = store.twilioWarning {
                Text(warning)
                    .font(VFont.caption)
                    .foregroundColor(VColor.warning)
            }

            if let error = store.twilioError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }

            // Guardian row (only when credentials exist)
            if store.twilioHasCredentials {
                Divider().background(VColor.surfaceBorder)
                guardianStatusRow(channel: "sms")
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Twilio Credential Entry

    private var twilioCredentialEntry: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                Text("Account SID and Auth Token")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
                VButton(label: "Cancel", style: .tertiary) {
                    twilioSetupExpanded = false
                    twilioAccountSidText = ""
                    twilioAuthTokenText = ""
                }
            }

            TextField("Account SID", text: $twilioAccountSidText)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.md)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )

            SecureField("Auth Token", text: $twilioAuthTokenText)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.md)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )

            if store.twilioSaveInProgress {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Saving...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            } else {
                VButton(label: "Save Credentials", style: .primary) {
                    store.saveTwilioCredentials(
                        accountSid: twilioAccountSidText,
                        authToken: twilioAuthTokenText
                    )
                    twilioAuthTokenText = ""
                    twilioSetupExpanded = false
                }
                .disabled(
                    twilioAccountSidText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                    twilioAuthTokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
            }
        }
    }

    // MARK: - Twilio Number Picker

    private var twilioNumberPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                Text("Phone Number")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
                VButton(label: "Cancel", style: .tertiary) {
                    twilioNumberPickerExpanded = false
                }
            }

            if store.twilioListInProgress {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading numbers...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            } else if store.twilioNumbers.isEmpty {
                Text("No phone numbers found on this Twilio account.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            } else {
                ForEach(store.twilioNumbers, id: \.phoneNumber) { number in
                    let isCurrent = number.phoneNumber == store.twilioPhoneNumber
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(number.phoneNumber)
                                .font(VFont.mono)
                                .foregroundColor(VColor.textPrimary)
                            Text(number.friendlyName)
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                        Spacer()
                        if isCurrent {
                            HStack(spacing: VSpacing.xs) {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundColor(VColor.success)
                                    .font(.system(size: 12))
                                Text("Current")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textSecondary)
                            }
                        } else {
                            VButton(label: "Use", style: .secondary) {
                                store.assignTwilioNumber(phoneNumber: number.phoneNumber)
                                twilioNumberPickerExpanded = false
                            }
                            .disabled(store.twilioSaveInProgress)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Channel Status Row

    private struct RowAction {
        let label: String
        let style: VButton.Style
        var disabled: Bool = false
        let action: () -> Void
    }

    @ViewBuilder
    private func channelStatusRow(
        label: String,
        icon: String,
        iconColor: Color,
        value: String,
        valueFont: Font = VFont.body,
        valueColor: Color = VColor.textSecondary,
        action: RowAction? = nil
    ) -> some View {
        HStack(spacing: VSpacing.sm) {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .frame(width: 90, alignment: .leading)

            Image(systemName: icon)
                .foregroundColor(iconColor)
                .font(.system(size: 12))

            Text(value)
                .font(valueFont)
                .foregroundColor(valueColor)
                .lineLimit(1)

            Spacer()

            if let action {
                VButton(label: action.label, style: action.style, action: action.action)
                    .disabled(action.disabled)
            }
        }
    }

    // MARK: - Guardian Verification Row

    @ViewBuilder
    private func guardianStatusRow(channel: String) -> some View {
        let identity: String? = channel == "telegram" ? store.telegramGuardianIdentity : store.smsGuardianIdentity
        let verified: Bool = channel == "telegram" ? store.telegramGuardianVerified : store.smsGuardianVerified
        let inProgress: Bool = channel == "telegram" ? store.telegramGuardianVerificationInProgress : store.smsGuardianVerificationInProgress
        let instruction: String? = channel == "telegram" ? store.telegramGuardianInstruction : store.smsGuardianInstruction
        let error: String? = channel == "telegram" ? store.telegramGuardianError : store.smsGuardianError

        VStack(alignment: .leading, spacing: VSpacing.sm) {
            if verified {
                channelStatusRow(
                    label: "Guardian",
                    icon: "checkmark.shield.fill",
                    iconColor: VColor.success,
                    value: identity.map { "Verified: \($0)" } ?? "Verified",
                    action: .init(label: "Revoke", style: .danger) {
                        store.revokeChannelGuardian(channel: channel)
                    }
                )
            } else if inProgress {
                HStack(spacing: VSpacing.sm) {
                    Text("Guardian")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .frame(width: 90, alignment: .leading)
                    ProgressView()
                        .controlSize(.small)
                    Text("Generating verification code...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
                Text("You will get a code to send as /guardian_verify <code> from your \(channel == "telegram" ? "Telegram account" : "SMS number").")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .padding(.leading, 90 + VSpacing.sm)
            } else if let instruction {
                HStack(spacing: VSpacing.sm) {
                    Text("Guardian")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .frame(width: 90, alignment: .leading)
                    Text(instruction)
                        .font(VFont.mono)
                        .foregroundColor(VColor.textPrimary)
                        .padding(VSpacing.md)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(VColor.surface)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                        )
                        .textSelection(.enabled)
                }
            } else {
                channelStatusRow(
                    label: "Guardian",
                    icon: "shield.slash",
                    iconColor: VColor.textMuted,
                    value: "Not verified",
                    valueColor: VColor.textMuted,
                    action: .init(label: "Verify", style: .secondary) {
                        store.startChannelGuardianVerification(channel: channel)
                    }
                )
            }

            if let error {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
                    .padding(.leading, 90 + VSpacing.sm)
            }
        }
    }

    // MARK: - Pairing Section

    private var pairingSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("QR Pairing")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Pair an iOS device")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Text("Generate a QR code for the Vellum iOS app to scan.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                Spacer()
                VButton(label: "Show QR Code", style: .primary) {
                    showingPairingQR = true
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Status Section

    private var statusSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Status")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            if store.ingressPublicBaseUrl.isEmpty {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(VColor.warning)
                        .font(.system(size: 14))
                    Text("Set a Gateway URL to enable devices and integrations.")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
            } else if !store.ingressEnabled {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(VColor.warning)
                        .font(.system(size: 14))
                    Text("Gateway URL is set but ingress is disabled. Enable ingress in Advanced settings to allow pairing.")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
            } else {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                        .font(.system(size: 14))
                    Text("Configured")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
            }

            Text("This URL is used by your devices and integrations to reach this Mac.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Test Connection Section

    private var testConnectionSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Test Connection")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            // Test Connection button
            HStack(spacing: VSpacing.sm) {
                if store.isCheckingGateway {
                    VLoadingIndicator(size: 14, color: VColor.accent)
                    Text("Checking...")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                } else {
                    VButton(
                        label: "Test Connection",
                        leftIcon: "antenna.radiowaves.left.and.right",
                        style: .secondary,
                        isDisabled: store.isCheckingGateway
                    ) {
                        Task { await store.testGatewayConnection() }
                    }
                }
            }

            // Gateway status row
            connectionStatusRow(
                label: "Gateway",
                status: gatewayStatusInfo
            )

            // Tunnel status row
            connectionStatusRow(
                label: "Tunnel",
                status: tunnelStatusInfo
            )

            // Diagnostic message when gateway is up but tunnel is down
            if store.gatewayReachable == true,
               !store.ingressPublicBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               store.ingressReachable == false {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(VColor.warning)
                        .font(.system(size: 12))
                    Text("Gateway is running but tunnel is unreachable. Check your tunnel configuration.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.warning)
                }
            }

            // Last verified timestamp
            if let lastChecked = store.gatewayLastChecked {
                Text("Last verified: \(relativeTimeString(from: lastChecked))")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }

            // Helper text
            Text("Gateway checks the local process. Tunnel checks the public URL.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Connection Status Helpers

    private struct ConnectionStatusInfo {
        let label: String
        let color: Color
        let icon: String
    }

    private var gatewayStatusInfo: ConnectionStatusInfo {
        guard let reachable = store.gatewayReachable else {
            return ConnectionStatusInfo(label: "Unknown", color: VColor.textMuted, icon: "questionmark.circle.fill")
        }
        if reachable {
            return ConnectionStatusInfo(label: "Running", color: VColor.success, icon: "checkmark.circle.fill")
        } else {
            return ConnectionStatusInfo(label: "Stopped", color: VColor.error, icon: "xmark.circle.fill")
        }
    }

    private var tunnelStatusInfo: ConnectionStatusInfo {
        let trimmedUrl = store.ingressPublicBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines)

        // No URL configured
        if trimmedUrl.isEmpty {
            return ConnectionStatusInfo(label: "Not configured", color: VColor.textMuted, icon: "minus.circle.fill")
        }

        // URL is non-empty but not a valid absolute HTTP(S) URL
        if let parsed = URL(string: trimmedUrl), let scheme = parsed.scheme, ["http", "https"].contains(scheme.lowercased()) {
            // valid — fall through to reachability check below
        } else {
            return ConnectionStatusInfo(label: "Invalid URL format", color: VColor.error, icon: "exclamationmark.circle.fill")
        }

        // Haven't tested yet
        guard let reachable = store.ingressReachable else {
            return ConnectionStatusInfo(label: "Unknown", color: VColor.textMuted, icon: "questionmark.circle.fill")
        }

        if reachable {
            return ConnectionStatusInfo(label: "Reachable", color: VColor.success, icon: "checkmark.circle.fill")
        } else {
            return ConnectionStatusInfo(label: "Unreachable", color: VColor.error, icon: "xmark.circle.fill")
        }
    }

    private func connectionStatusRow(label: String, status: ConnectionStatusInfo) -> some View {
        HStack(spacing: VSpacing.sm) {
            Text(label)
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.textSecondary)
                .frame(width: 60, alignment: .leading)

            Image(systemName: status.icon)
                .foregroundColor(status.color)
                .font(.system(size: 12))

            Text(status.label)
                .font(VFont.body)
                .foregroundColor(status.color)
        }
    }

    /// Returns a human-readable relative time string (e.g. "just now", "2 minutes ago").
    private func relativeTimeString(from date: Date) -> String {
        let seconds = Int(-date.timeIntervalSinceNow)
        if seconds < 5 { return "just now" }
        if seconds < 60 { return "\(seconds) seconds ago" }
        let minutes = seconds / 60
        if minutes == 1 { return "1 minute ago" }
        if minutes < 60 { return "\(minutes) minutes ago" }
        let hours = minutes / 60
        if hours == 1 { return "1 hour ago" }
        return "\(hours) hours ago"
    }

    // MARK: - Token Helpers

    private func refreshBearerToken() {
        bearerToken = readHttpToken() ?? ""
    }

    private func regenerateHttpToken() {
        let tokenPath = resolveHttpTokenPath()
        // Generate new random bytes before deleting the old file so a
        // SecRandomCopyBytes failure doesn't leave us with no token at all.
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return }
        let newToken = bytes.map { String(format: "%02x", $0) }.joined()
        try? FileManager.default.removeItem(atPath: tokenPath)
        let dir = (tokenPath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: tokenPath, contents: Data(newToken.utf8), attributes: [.posixPermissions: 0o600])
        bearerToken = newToken
        // Kill the daemon so the health monitor restarts it with the new token.
        // The daemon only reads the token at startup, so a restart is required.
        let pidPath = resolvePidPath()
        if let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           let pid = Int32(pidStr) {
            kill(pid, SIGTERM)
        }
    }
}

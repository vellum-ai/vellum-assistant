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
    var authManager: AuthManager

    @State private var gatewayUrlText: String = ""
    @FocusState private var isGatewayUrlFocused: Bool
    @State private var bearerToken: String = ""
    @State private var tokenRevealed: Bool = false
    @State private var tokenCopied: Bool = false
    @State private var gatewayTargetCopied: Bool = false
    @State private var showingPairingQR: Bool = false
    @State private var showingRegenerateConfirmation: Bool = false
    @State private var gatewayExpanded: Bool = true
    @State private var advancedExpanded: Bool = false
    @State private var diagnosticsExpanded: Bool = false

    // Telegram credential entry
    @State private var telegramBotTokenText = ""
    @State private var telegramSetupExpanded = false

    // Twilio credential entry
    @State private var twilioAccountSidText = ""
    @State private var twilioAuthTokenText = ""
    @State private var twilioSetupExpanded = false

    // Twilio number picker
    @State private var twilioNumberPickerExpanded = false

    // Email copy state
    @State private var emailCopied: Bool = false

    // Guardian copy state (tracks which channel's command was just copied)
    @State private var guardianCommandCopiedChannel: String?

    // Token regeneration state
    @State private var isRegeneratingToken: Bool = false

    // Override fields for power users / debugging
    @AppStorage(PairingConfiguration.gatewayOverrideKey) private var iosPairingGatewayOverride: String = ""
    @AppStorage(PairingConfiguration.tokenOverrideKey) private var iosPairingTokenOverride: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            vellumSection
            gatewaySection
            advancedSection
            diagnosticsSection
            connectionsSection
        }
        .onAppear {
            Task { await authManager.checkSession() }
            if store.isDevMode { Task { await store.checkVellumPlatform() } }
            store.refreshIngressConfig()
            store.refreshAssistantEmail()
            store.refreshApprovedDevices()
            gatewayUrlText = store.ingressPublicBaseUrl
            refreshBearerToken()
            store.refreshChannelGuardianStatus(channel: "telegram")
            store.refreshChannelGuardianStatus(channel: "sms")
            store.refreshChannelGuardianStatus(channel: "voice")
            gatewayExpanded = store.ingressPublicBaseUrl.isEmpty
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
        .onChange(of: store.twilioHasCredentials) { _, hasCredentials in
            if !hasCredentials {
                twilioSetupExpanded = false
                twilioNumberPickerExpanded = false
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
                gatewayUrl: store.resolvedIosGatewayUrl,
                daemonClient: daemonClient
            )
        }
    }

    // MARK: - Vellum Section

    private var platformHealthIcon: String {
        if store.isCheckingVellumPlatform {
            return "arrow.trianglehead.2.counterclockwise"
        }
        switch store.vellumPlatformReachable {
        case .some(true): return "checkmark.circle.fill"
        case .some(false): return "xmark.circle.fill"
        case .none: return "questionmark.circle"
        }
    }

    private var platformHealthIconColor: Color {
        if store.isCheckingVellumPlatform {
            return VColor.textMuted
        }
        switch store.vellumPlatformReachable {
        case .some(true): return VColor.success
        case .some(false): return VColor.error
        case .none: return VColor.textMuted
        }
    }

    private var vellumSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Vellum")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            if authManager.isLoading {
                channelStatusRow(
                    label: "Account",
                    icon: "arrow.trianglehead.2.counterclockwise",
                    iconColor: VColor.textMuted,
                    value: "Checking..."
                )
            } else if let user = authManager.currentUser {
                channelStatusRow(
                    label: "Account",
                    icon: "checkmark.circle.fill",
                    iconColor: VColor.success,
                    value: user.email ?? user.display ?? "Signed in",
                    action: .init(label: "Log Out", style: .danger) {
                        Task { await authManager.logout() }
                    }
                )
            } else {
                channelStatusRow(
                    label: "Account",
                    icon: "xmark.circle",
                    iconColor: VColor.textMuted,
                    value: "Not signed in",
                    action: .init(
                        label: authManager.isSubmitting ? "Signing in..." : "Log In",
                        style: .primary,
                        disabled: authManager.isSubmitting
                    ) {
                        Task { await authManager.startWorkOSLogin() }
                    }
                )
            }

            if let error = authManager.errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }

            if store.isDevMode {
                Divider().background(VColor.surfaceBorder)

                channelStatusRow(
                    label: "Platform URL",
                    icon: platformHealthIcon,
                    iconColor: platformHealthIconColor,
                    value: AuthService.shared.baseURL,
                    valueFont: VFont.mono
                )
                .help(store.vellumPlatformError ?? "")
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Gateway Section

    private var gatewaySection: some View {
        VDisclosureSection(
            title: "Gateway",
            icon: "network",
            subtitle: !gatewayExpanded && !store.ingressPublicBaseUrl.isEmpty ? store.ingressPublicBaseUrl : nil,
            isExpanded: $gatewayExpanded
        ) {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                // Gateway URL field
                HStack(spacing: VSpacing.xs) {
                    Text("Gateway URL")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }

                TextField("https://your-tunnel.example.com", text: $gatewayUrlText)
                    .focused($isGatewayUrlFocused)
                    .vInputStyle()
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)

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
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Bearer Token Content

    private var bearerTokenContent: some View {
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
    }

    // MARK: - Connections Section

    private var connectionsSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Connections")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            mobileCard
            telegramCard
            twilioCard
            voiceCard
            emailCard
        }
    }

    // MARK: - Email Channel Card

    private var emailCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Email")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Text("Send and receive emails as your assistant")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }

            if let email = store.assistantEmail {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                        .font(.system(size: 14))
                    Text(email)
                        .font(VFont.mono)
                        .foregroundColor(VColor.textPrimary)
                        .textSelection(.enabled)
                    Spacer()
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(email, forType: .string)
                        emailCopied = true
                        Task {
                            try? await Task.sleep(nanoseconds: 2_000_000_000)
                            emailCopied = false
                        }
                    } label: {
                        Image(systemName: emailCopied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(emailCopied ? VColor.success : VColor.textSecondary)
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Copy email address")
                    .help("Copy email address")
                }
            } else {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundColor(VColor.warning)
                        .font(.system(size: 12))
                    Text("Not configured — run the Email Setup skill to assign an address")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Advanced Section

    private var advancedSection: some View {
        VDisclosureSection(
            title: "Advanced",
            icon: "gearshape",
            subtitle: "Bearer token, overrides",
            isExpanded: $advancedExpanded
        ) {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                bearerTokenContent

                Divider().background(VColor.surfaceBorder)

                // Developer local pairing content removed in v4 — LAN pairing is automatic via localLanUrl in QR payload.

                // Simple override fields for power users / debugging
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("URL Override (optional)")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                    TextField("Custom gateway URL", text: $iosPairingGatewayOverride)
                        .vInputStyle()
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                }

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Token Override (optional)")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                    SecureField("Custom bearer token", text: $iosPairingTokenOverride)
                        .vInputStyle()
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
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
                    valueURL: store.telegramBotUsername.flatMap { URL(string: "https://web.telegram.org/k/#@\($0)") },
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
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)

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
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("SMS")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Text("Text your assistant using Twilio as the SMS provider")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }

            // Credentials row
            if store.twilioHasCredentials {
                channelStatusRow(
                    label: "Credentials",
                    icon: "checkmark.circle.fill",
                    iconColor: VColor.success,
                    value: "Configured",
                    action: .init(label: "Clear", style: .danger, disabled: store.twilioSaveInProgress) {
                        store.clearTwilioCredentials()
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

    // MARK: - Voice (Phone Calls) Card

    private var voiceCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "phone.fill")
                        .foregroundColor(VColor.textPrimary)
                        .font(.system(size: 12))
                    Text("Voice (Phone Calls)")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)
                }
                Text("Receive and make phone calls via Twilio")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }

            if store.twilioHasCredentials && store.twilioPhoneNumber != nil {
                channelStatusRow(
                    label: "Status",
                    icon: "checkmark.circle.fill",
                    iconColor: VColor.success,
                    value: "Voice calls ready"
                )
                channelStatusRow(
                    label: "Number",
                    icon: "phone.fill",
                    iconColor: VColor.success,
                    value: store.twilioPhoneNumber ?? "",
                    valueFont: VFont.mono
                )

                Divider().background(VColor.surfaceBorder)
                guardianStatusRow(channel: "voice")
            } else if store.twilioHasCredentials {
                channelStatusRow(
                    label: "Credentials",
                    icon: "checkmark.circle.fill",
                    iconColor: VColor.success,
                    value: "Configured"
                )
                channelStatusRow(
                    label: "Number",
                    icon: "exclamationmark.triangle",
                    iconColor: VColor.warning,
                    value: "Assign a phone number in SMS settings above",
                    valueColor: VColor.textMuted
                )
            } else {
                channelStatusRow(
                    label: "Status",
                    icon: "exclamationmark.triangle",
                    iconColor: VColor.warning,
                    value: "Configure Twilio credentials in SMS settings above",
                    valueColor: VColor.textMuted
                )
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
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)

            SecureField("Auth Token", text: $twilioAuthTokenText)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)

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
                    twilioAccountSidText = ""
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
        valueURL: URL? = nil,
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

            if let url = valueURL {
                Link(value, destination: url)
                    .font(valueFont)
                    .lineLimit(1)
                    .onHover { hovering in
                        if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                    }
            } else {
                Text(value)
                    .font(valueFont)
                    .foregroundColor(valueColor)
                    .lineLimit(1)
            }

            Spacer()

            if let action {
                VButton(label: action.label, style: action.style, action: action.action)
                    .disabled(action.disabled)
            }
        }
    }

    // MARK: - Guardian Verification Row

    private var guardianLabel: some View {
        HStack(spacing: VSpacing.xs) {
            Text("Verification")
            Image(systemName: "info.circle")
                .font(.system(size: 10))
                .foregroundColor(VColor.textMuted)
                .help("Guardian verification links your account identity for this channel.")
        }
        .font(VFont.caption)
        .foregroundColor(VColor.textSecondary)
        .frame(width: 90, alignment: .leading)
    }

    private func guardianPrimaryIdentity(channel: String, identity: String?) -> String? {
        if channel == "telegram" {
            if let username = store.telegramGuardianUsername?.trimmingCharacters(in: .whitespacesAndNewlines),
               !username.isEmpty {
                return username.hasPrefix("@") ? username : "@\(username)"
            }
            if let displayName = store.telegramGuardianDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines),
               !displayName.isEmpty {
                return displayName
            }
        } else if channel == "sms" {
            if let displayName = store.smsGuardianDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines),
               !displayName.isEmpty {
                return displayName
            }
        } else if channel == "voice" {
            if let displayName = store.voiceGuardianDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines),
               !displayName.isEmpty {
                return displayName
            }
        }
        return identity
    }

    private func guardianSecondaryIdentity(primary: String?, identity: String?) -> String? {
        guard let identity = identity?.trimmingCharacters(in: .whitespacesAndNewlines), !identity.isEmpty else {
            return nil
        }
        if let primary {
            let normalizedPrimary = primary.trimmingCharacters(in: .whitespacesAndNewlines)
            if normalizedPrimary.caseInsensitiveCompare(identity) == .orderedSame {
                return nil
            }
        }
        return "ID: \(identity)"
    }

    @ViewBuilder
    private func guardianStatusRow(channel: String) -> some View {
        let identity: String? = {
            switch channel {
            case "telegram": return store.telegramGuardianIdentity
            case "sms": return store.smsGuardianIdentity
            case "voice": return store.voiceGuardianIdentity
            default: return nil
            }
        }()
        let verified: Bool = {
            switch channel {
            case "telegram": return store.telegramGuardianVerified
            case "sms": return store.smsGuardianVerified
            case "voice": return store.voiceGuardianVerified
            default: return false
            }
        }()
        let inProgress: Bool = {
            switch channel {
            case "telegram": return store.telegramGuardianVerificationInProgress
            case "sms": return store.smsGuardianVerificationInProgress
            case "voice": return store.voiceGuardianVerificationInProgress
            default: return false
            }
        }()
        let instruction: String? = {
            switch channel {
            case "telegram": return store.telegramGuardianInstruction
            case "sms": return store.smsGuardianInstruction
            case "voice": return store.voiceGuardianInstruction
            default: return nil
            }
        }()
        let error: String? = {
            switch channel {
            case "telegram": return store.telegramGuardianError
            case "sms": return store.smsGuardianError
            case "voice": return store.voiceGuardianError
            default: return nil
            }
        }()
        let primaryIdentity = guardianPrimaryIdentity(channel: channel, identity: identity)
        let secondaryIdentity = guardianSecondaryIdentity(primary: primaryIdentity, identity: identity)
        let telegramProfileURL: URL? = channel == "telegram"
            ? identity.flatMap { URL(string: "https://web.telegram.org/a/#\($0)") }
            : nil

        VStack(alignment: .leading, spacing: VSpacing.sm) {
            if verified {
                HStack(spacing: VSpacing.sm) {
                    guardianLabel
                    Image(systemName: "checkmark.shield.fill")
                        .foregroundColor(VColor.success)
                        .font(.system(size: 12))
                    VStack(alignment: .leading, spacing: 2) {
                        if let telegramProfileURL {
                            Link(primaryIdentity ?? "Verified", destination: telegramProfileURL)
                                .font(VFont.body)
                                .lineLimit(1)
                                .onHover { hovering in
                                    if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                                }
                        } else {
                            Text(primaryIdentity ?? "Verified")
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                                .lineLimit(1)
                        }
                        if let secondaryIdentity {
                            if let telegramProfileURL {
                                Link(secondaryIdentity, destination: telegramProfileURL)
                                    .font(VFont.caption)
                                    .lineLimit(1)
                                    .onHover { hovering in
                                        if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                                    }
                            } else {
                                Text(secondaryIdentity)
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textMuted)
                                    .lineLimit(1)
                            }
                        }
                    }
                    Spacer()
                    VButton(label: "Revoke", style: .danger) {
                        store.revokeChannelGuardian(channel: channel)
                    }
                }
            } else if inProgress {
                HStack(spacing: VSpacing.sm) {
                    guardianLabel
                    ProgressView()
                        .controlSize(.small)
                    Text("Generating verification code...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            } else if let instruction {
                guardianInstructionView(channel: channel, instruction: instruction)
            } else {
                HStack(spacing: VSpacing.sm) {
                    guardianLabel
                    Image(systemName: "shield.slash")
                        .foregroundColor(VColor.textMuted)
                        .font(.system(size: 12))
                    Text("Not verified")
                        .font(VFont.body)
                        .foregroundColor(VColor.textMuted)
                        .lineLimit(1)
                    Spacer()
                    VButton(label: "Verify", style: .secondary) {
                        store.startChannelGuardianVerification(channel: channel)
                    }
                }
            }

            if let error {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
                    .padding(.leading, 90 + VSpacing.sm)
            }
        }
    }

    private func guardianInstructionSubtext(channel: String) -> String {
        if channel == "telegram" {
            let handle = store.telegramBotUsername.map { "@\($0)" } ?? "your bot"
            return "Message \(handle) with the below command within the next 10 minutes"
        } else if channel == "voice" {
            let number = store.twilioPhoneNumber ?? "your assistant"
            return "Call \(number) and say the six-digit code below within the next 10 minutes"
        } else {
            let number = store.twilioPhoneNumber ?? "your assistant"
            return "Text \(number) with the below command within the next 10 minutes"
        }
    }

    /// Extracts the `/guardian_verify <hex>` command from a raw instruction string.
    private func extractGuardianCommand(from instruction: String) -> String? {
        guard let range = instruction.range(of: #"`?/guardian_verify\s+[0-9a-fA-F]+`?"#, options: .regularExpression) else {
            return nil
        }
        return String(instruction[range]).trimmingCharacters(in: CharacterSet(charactersIn: "`"))
    }

    /// Extracts a six-digit verification code from voice-style instruction text.
    /// Voice instructions use a format like "...six-digit code: 123456..." instead of the
    /// `/guardian_verify <hex>` command used by Telegram and SMS channels.
    private func extractVoiceGuardianCode(from instruction: String) -> String? {
        guard let range = instruction.range(of: #"six-digit code:\s*(\d{6})"#, options: .regularExpression) else {
            return nil
        }
        let match = String(instruction[range])
        // Extract just the digits from "six-digit code: 123456"
        guard let digitRange = match.range(of: #"\d{6}"#, options: .regularExpression) else {
            return nil
        }
        return String(match[digitRange])
    }

    @ViewBuilder
    private func guardianInstructionView(channel: String, instruction: String) -> some View {
        // Voice uses a different instruction format ("six-digit code: 123456") vs
        // Telegram/SMS which use "/guardian_verify <hex>".
        let command: String? = channel == "voice"
            ? extractVoiceGuardianCode(from: instruction)
            : extractGuardianCommand(from: instruction)
        let isCopied = guardianCommandCopiedChannel == channel

        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                guardianLabel
                Image(systemName: "shield.lefthalf.filled")
                    .foregroundColor(VColor.warning)
                    .font(.system(size: 12))
                Text("Verification pending")
                    .font(VFont.body)
                    .foregroundColor(VColor.warning)
                Spacer()
                VButton(label: "Cancel", style: .tertiary) {
                    store.cancelGuardianChallenge(channel: channel)
                }
            }

            if let command {
                Text(guardianInstructionSubtext(channel: channel))
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .padding(.leading, 90 + VSpacing.sm)

                HStack(spacing: VSpacing.sm) {
                    Text(command)
                        .font(VFont.mono)
                        .foregroundColor(VColor.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)

                    Spacer()

                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(command, forType: .string)
                        guardianCommandCopiedChannel = channel
                        Task {
                            try? await Task.sleep(nanoseconds: 2_000_000_000)
                            if guardianCommandCopiedChannel == channel {
                                guardianCommandCopiedChannel = nil
                            }
                        }
                    } label: {
                        HStack(spacing: VSpacing.xs) {
                            Image(systemName: isCopied ? "checkmark" : "doc.on.doc")
                                .font(.system(size: 12, weight: .medium))
                            Text(isCopied ? "Copied" : "Copy")
                                .font(VFont.caption)
                        }
                        .foregroundColor(isCopied ? VColor.success : VColor.textSecondary)
                        .frame(height: 28)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Copy verification command")
                    .help("Copy command")
                }
                .padding(VSpacing.md)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )
                .padding(.leading, 90 + VSpacing.sm)
            } else {
                // Fallback: show raw instruction if command can't be parsed
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
                    .padding(.leading, 90 + VSpacing.sm)
            }
        }
    }

    // MARK: - Mobile Card (Pairing + Approved Devices)

    private var mobileCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Mobile")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Text("Connect your phone to your assistant through the iOS app")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }

            VButton(label: "Show QR Code", leftIcon: "qrcode", style: .primary) {
                showingPairingQR = true
            }
            .disabled(isRegeneratingToken)

            // Status line — use resolvedIosGatewayUrl for gateway (no I/O) and
            // cached bearerToken + override for token (avoids synchronous disk read).
            // LAN pairing works without a cloud gateway URL.
            let hasGateway = !store.resolvedIosGatewayUrl.isEmpty || LANIPHelper.currentLANAddress() != nil
            let trimmedOverrideToken = iosPairingTokenOverride.trimmingCharacters(in: .whitespacesAndNewlines)
            let hasToken = !bearerToken.isEmpty || !trimmedOverrideToken.isEmpty
            let tokenFromDaemon = !bearerToken.isEmpty && trimmedOverrideToken.isEmpty

            if isRegeneratingToken {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Restarting daemon with new token\u{2026}")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
            } else if hasGateway && hasToken {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                        .font(.system(size: 14))
                    Text("Ready to pair")
                        .font(VFont.body)
                        .foregroundColor(VColor.success)
                    if tokenFromDaemon {
                        Spacer()
                        Button("Regenerate Token") {
                            showingRegenerateConfirmation = true
                        }
                        .buttonStyle(.plain)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                        .help("Replace the current token. Paired devices will need to reconnect.")
                    }
                }
            } else if !hasGateway {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(VColor.warning)
                        .font(.system(size: 14))
                    Text("Configure a gateway URL to enable pairing")
                        .font(VFont.body)
                        .foregroundColor(VColor.warning)
                }
            } else {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    HStack(spacing: VSpacing.sm) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundColor(VColor.warning)
                            .font(.system(size: 14))
                        Text("Bearer token required")
                            .font(VFont.body)
                            .foregroundColor(VColor.warning)
                    }
                    VButton(label: "Generate Token", leftIcon: "key", style: .secondary) {
                        regenerateHttpToken()
                    }
                }
            }

            // Connected devices
            if !store.approvedDevices.isEmpty {
                Divider().background(VColor.surfaceBorder)

                ForEach(store.approvedDevices, id: \.hashedDeviceId) { device in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(device.deviceName)
                                .font(VFont.body)
                                .foregroundColor(VColor.textPrimary)
                            Text("Last paired: \(formattedDeviceDate(device.lastPairedAt))")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                        Spacer()
                        Button("Remove") {
                            store.removeApprovedDevice(hashedDeviceId: device.hashedDeviceId)
                        }
                        .font(VFont.caption)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                    .padding(.vertical, VSpacing.xs)
                }

                Button("Clear All") {
                    store.clearAllApprovedDevices()
                }
                .font(VFont.caption)
                .foregroundColor(VColor.error)
                .buttonStyle(.borderless)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
    }

    private func formattedDeviceDate(_ timestamp: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(timestamp) / 1000.0)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    // MARK: - Diagnostics Section (merged Status + Test Connection)

    private var diagnosticsSection: some View {
        VDisclosureSection(
            title: "Diagnostics",
            icon: "stethoscope",
            isExpanded: $diagnosticsExpanded
        ) {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                statusContent

                Divider().background(VColor.surfaceBorder)

                testConnectionContent
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    @ViewBuilder
    private var statusContent: some View {
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
                Text("Gateway URL is set but the gateway is not active. Check your tunnel or gateway configuration.")
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

    @ViewBuilder
    private var testConnectionContent: some View {
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
        Text("Gateway checks the local daemon. Tunnel checks the public URL.")
            .font(VFont.caption)
            .foregroundColor(VColor.textMuted)
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
        isRegeneratingToken = true
        let pidPath = resolvePidPath()
        if let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           let pid = Int32(pidStr) {
            kill(pid, SIGTERM)
        }
        // Wait for the daemon to restart and become reachable with the new token.
        Task {
            let port = ProcessInfo.processInfo.environment["RUNTIME_HTTP_PORT"]
                .flatMap(Int.init) ?? 7821
            let url = URL(string: "http://localhost:\(port)/healthz")!
            var request = URLRequest(url: url)
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            request.timeoutInterval = 2
            for _ in 0..<30 { // up to ~30s
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if let (_, response) = try? await URLSession.shared.data(for: request),
                   let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    isRegeneratingToken = false
                    return
                }
            }
            isRegeneratingToken = false
        }
    }
}

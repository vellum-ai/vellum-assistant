import Combine
import SwiftUI
import VellumAssistantShared

/// Detail view for a single contact, showing header info (including notes),
/// channels with verification status, and action buttons.
@MainActor
struct ContactDetailView: View {
    private static let allChannelTypes = ["telegram", "sms", "email", "voice", "slack"]

    private static let guardianSupportedChannels: Set<String> = ["telegram", "sms", "voice", "slack"]

    let contact: ContactPayload
    var daemonClient: DaemonClient?
    var store: SettingsStore?

    @State var currentContact: ContactPayload?
    @State private var actionInProgress: String?
    @State var errorMessage: String?
    @State private var isEditing = false
    @State private var editedName = ""
    @State private var editedNotes = ""
    @State private var isSaving = false
    @State private var isHoveringHeader = false
    @State private var verificationInProgress: String?
    @State private var verificationSuccessChannelId: String?
    @State private var telegramBootstrapUrl: String?
    @State private var telegramBootstrapChannelId: String?
    @State private var inviteInProgress: String?
    @State private var inviteResult: (
        type: String,
        token: String,
        shareUrl: String?,
        inviteCode: String?,
        guardianInstruction: String?,
        channelHandle: String?
    )?
    @State private var inviteError: String?
    @State private var inviteCopiedType: String?
    @State private var channelReadiness: [String: DaemonClient.ChannelReadinessInfo] = [:]
    @State private var guardianDestinationTexts: [String: String] = [:]
    @State private var guardianCountdownNow: Date = Date()
    @State private var guardianCountdownTimer: Timer?
    /// Incremented whenever SettingsStore publishes a change, forcing SwiftUI to
    /// re-evaluate guardian verification state derived from the store.
    @State private var guardianStoreRevision: Int = 0

    var displayContact: ContactPayload {
        currentContact ?? contact
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                headerSection
                channelsSection
            }
            .padding(VSpacing.xl)
        }
        .background(VColor.background)
        .onAppear {
            currentContact = contact
            if contact.role == "guardian" {
                startGuardianCountdownTimer()
            }
        }
        .onDisappear {
            stopGuardianCountdownTimer()
        }
        .onReceive(store?.objectWillChange.map { _ in () }.eraseToAnyPublisher() ?? Empty().eraseToAnyPublisher()) { _ in
            guardianStoreRevision += 1
        }
    }

    // MARK: - Header Section

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                if isEditing && displayContact.role != "guardian" {
                    TextField("Display name", text: $editedName)
                        .font(VFont.largeTitle)
                        .foregroundColor(VColor.textPrimary)
                        .textFieldStyle(.plain)
                        .onSubmit { Task { await saveCardEdits() } }
                } else {
                    Text(displayContact.displayName)
                        .font(VFont.largeTitle)
                        .foregroundColor(VColor.textPrimary)
                }

                Spacer()

                if isEditing {
                    HStack(spacing: VSpacing.sm) {
                        VButton(label: "Save", style: .primary, size: .medium, isDisabled: isSaving) {
                            Task { await saveCardEdits() }
                        }
                        Button {
                            isEditing = false
                        } label: {
                            Text("Cancel")
                                .font(VFont.captionMedium)
                                .foregroundColor(VColor.textMuted)
                        }
                        .buttonStyle(.plain)
                        .keyboardShortcut(.escape, modifiers: [])
                    }
                } else {
                    Button {
                        editedName = displayContact.displayName
                        editedNotes = displayContact.notes ?? ""
                        isEditing = true
                    } label: {
                        Image(systemName: "pencil")
                            .foregroundColor(VColor.textSecondary)
                            .font(.system(size: 12))
                    }
                    .buttonStyle(.plain)
                    .opacity(isHoveringHeader ? 1 : 0)
                    .animation(VAnimation.fast, value: isHoveringHeader)
                    .accessibilityLabel("Edit contact")
                }
            }

            HStack(spacing: VSpacing.sm) {
                roleBadge
                contactTypeBadge
            }

            HStack(spacing: VSpacing.sm) {
                Text("\(displayContact.interactionCount) interaction\(displayContact.interactionCount == 1 ? "" : "s")")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                if let lastInteraction = displayContact.lastInteraction {
                    Text("\u{00B7}")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    Text("Last \(relativeTime(epochMs: Int(lastInteraction)))")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }

            Divider().background(VColor.divider)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Notes")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)

                if isEditing {
                    TextEditor(text: $editedNotes)
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 60, maxHeight: 160)
                        .padding(VSpacing.xs)
                        .background(VColor.inputBackground)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                } else if let notes = displayContact.notes, !notes.isEmpty {
                    Text(notes)
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text("No notes")
                        .font(VFont.body)
                        .foregroundColor(VColor.textMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
        .onHover { hovering in
            isHoveringHeader = hovering
        }
    }

    private var roleBadge: some View {
        Group {
            if displayContact.role == "guardian" {
                Text("Guardian")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.accent)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xxs)
                    .background(VColor.accentSubtle)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
            } else {
                Text("Contact")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.textSecondary)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xxs)
                    .background(VColor.surfaceSubtle)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
            }
        }
    }

    private var contactTypeBadge: some View {
        VBadge(
            style: .label(formatContactType(displayContact.contactType)),
            color: displayContact.contactType == "assistant"
                ? VColor.accent
                : VColor.textSecondary
        )
    }

    // MARK: - Channels Section

    private var channelsSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Channels")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            let channelsByType = Dictionary(
                grouping: displayContact.channels,
                by: { $0.type }
            )
            let extraChannels = displayContact.channels.filter { !Self.allChannelTypes.contains($0.type) }
            let totalRows = Self.allChannelTypes.count + extraChannels.count

            ForEach(Array(Self.allChannelTypes.enumerated()), id: \.element) { index, type in
                if let channels = channelsByType[type] {
                    ForEach(Array(channels.enumerated()), id: \.element.id) { channelIndex, channel in
                        channelRow(channel)

                        if channelIndex < channels.count - 1 {
                            Divider().background(VColor.divider)
                        }
                    }
                } else {
                    unconfiguredChannelRow(type: type)
                }

                if index < totalRows - 1 {
                    Divider().background(VColor.divider)
                }
            }

            ForEach(Array(extraChannels.enumerated()), id: \.element.id) { index, channel in
                channelRow(channel)

                if Self.allChannelTypes.count + index < totalRows - 1 {
                    Divider().background(VColor.divider)
                }
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }

            if let inviteError {
                Text(inviteError)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
        .task {
            do {
                channelReadiness = try await daemonClient?.fetchChannelReadiness() ?? [:]
            } catch {
                // Silently fail — empty dict means probed channels (SMS, Telegram,
                // Voice) hide their Invite buttons until a successful fetch, while
                // non-probed channels (email, Slack) default to showing Invite.
            }
        }
    }

    @ViewBuilder
    private func channelRow(_ channel: ContactChannelPayload) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: channelIcon(for: channel.type))
                    .foregroundColor(VColor.textSecondary)
                    .font(.system(size: 14))
                    .frame(width: 20, alignment: .center)

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: VSpacing.sm) {
                        Text(channel.address)
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                            .lineLimit(1)

                        statusBadge(for: channel)
                    }

                    if let verifiedAt = channel.verifiedAt, verifiedAt > 0 {
                        let dateStr = formatDate(epochMs: verifiedAt)
                        let via = channel.verifiedVia ?? "unknown"
                        Text("Verified via \(via) on \(dateStr)")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }

                    if let lastSeenAt = channel.lastSeenAt, lastSeenAt > 0 {
                        Text("Last seen \(relativeTime(epochMs: lastSeenAt))")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }

                    if channel.policy != "allow" {
                        HStack(spacing: VSpacing.xs) {
                            Image(systemName: "shield.fill")
                                .font(.system(size: 10))
                            Text("Policy: \(channel.policy)")
                                .font(VFont.caption)
                        }
                        .foregroundColor(VColor.warning)
                    }
                }

                Spacer()
            }

            // Guardian contacts get the full verification flow; others get standard actions
            if displayContact.role == "guardian" {
                guardianVerificationActions(for: channel)
            } else {
                channelActions(for: channel)
            }
        }
    }

    @ViewBuilder
    private func unconfiguredChannelRow(type: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: channelIcon(for: type))
                    .foregroundColor(VColor.textSecondary)
                    .font(.system(size: 14))
                    .frame(width: 20, alignment: .center)

                Text(channelLabel(for: type))
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)

                if let handle = channelReadiness[type]?.channelHandle {
                    Text(handle)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.textMuted)
                        .lineLimit(1)
                }

                Spacer()

                Text("Not set up")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)

                // Voice invites require additional fields (phone number, friend/guardian
                // names) that aren't available in this context, so hide the button.
                // Channels that require infrastructure probing (SMS, Telegram) only
                // show Invite when the server has explicitly confirmed readiness.
                // Non-probed channels (email, Slack) default to ready unless
                // explicitly marked false.
                let probedChannels: Set<String> = ["sms", "telegram", "voice"]
                let channelIsReady = probedChannels.contains(type)
                    ? channelReadiness[type]?.ready == true
                    : channelReadiness[type]?.ready != false
                if displayContact.role != "guardian" && type != "voice" && channelIsReady {
                    if inviteInProgress == type {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        VButton(
                            label: "Invite",
                            style: .secondary,
                            size: .medium,
                            isDisabled: inviteInProgress != nil
                        ) {
                            createInviteForChannel(type: type)
                        }
                    }
                }
            }

            if inviteResult?.type == type {
                inviteResultDisplay(for: type)
            }
        }
    }

    @ViewBuilder
    private func inviteResultDisplay(for type: String) -> some View {
        let result = inviteResult!

        if let inviteCode = result.inviteCode {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                if let instruction = result.guardianInstruction {
                    Text(instruction)
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let channelHandle = result.channelHandle {
                    Text(channelHandle)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.textMuted)
                }

                // When a share URL is available, show it prominently above the code
                if let shareUrl = result.shareUrl {
                    HStack(spacing: VSpacing.sm) {
                        let truncated = shareUrl.count > 30
                            ? String(shareUrl.prefix(30)) + "..."
                            : shareUrl
                        Text(truncated)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.textSecondary)

                        VButton(
                            label: inviteCopiedType == "\(type)-link" ? "Copied!" : "Copy Link",
                            icon: "doc.on.doc",
                            style: .secondary,
                            size: .medium
                        ) {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(shareUrl, forType: .string)
                            inviteCopiedType = "\(type)-link"
                            Task {
                                try? await Task.sleep(nanoseconds: 2_000_000_000)
                                guard !Task.isCancelled else { return }
                                if inviteCopiedType == "\(type)-link" {
                                    inviteCopiedType = nil
                                }
                            }
                        }
                    }

                    Divider().background(VColor.divider)

                    Text("Or use this code:")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }

                // Large monospaced invite code for readability
                Text(inviteCode)
                    .font(VFont.inviteCode)
                    .foregroundColor(VColor.textPrimary)
                    .tracking(4)
                    .padding(.vertical, VSpacing.xs)

                VButton(
                    label: inviteCopiedType == type ? "Copied!" : "Copy Code",
                    icon: "doc.on.doc",
                    style: result.shareUrl != nil ? .tertiary : .secondary,
                    size: .medium
                ) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(inviteCode, forType: .string)
                    inviteCopiedType = type
                    Task {
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                        guard !Task.isCancelled else { return }
                        if inviteCopiedType == type {
                            inviteCopiedType = nil
                        }
                    }
                }
            }
        } else {
            // Fallback: no invite code available, show raw token
            HStack(spacing: VSpacing.sm) {
                let shareableText = result.shareUrl ?? result.token
                let truncated = shareableText.count > 20
                    ? String(shareableText.prefix(20)) + "..."
                    : shareableText
                Text(truncated)
                    .font(VFont.monoSmall)
                    .foregroundColor(VColor.textSecondary)

                VButton(
                    label: inviteCopiedType == type ? "Copied!" : "Copy",
                    icon: "doc.on.doc",
                    style: .tertiary,
                    size: .medium
                ) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(shareableText, forType: .string)
                    inviteCopiedType = type
                    Task {
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                        guard !Task.isCancelled else { return }
                        if inviteCopiedType == type {
                            inviteCopiedType = nil
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func channelActions(for channel: ContactChannelPayload) -> some View {
        // Disable ALL action buttons while any channel action is in-flight to
        // serialize updates and prevent response correlation mix-ups.
        let anyActionInFlight = actionInProgress != nil || verificationInProgress != nil
        let isThisChannel = actionInProgress == channel.id

        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                switch channel.status {
                case "revoked":
                    VButton(
                        label: "Restore Access",
                        style: .secondary,
                        size: .medium,
                        isDisabled: anyActionInFlight
                    ) {
                        updateChannelStatus(channelId: channel.id, status: "active")
                    }
                case "blocked":
                    VButton(
                        label: "Restore Access",
                        style: .secondary,
                        size: .medium,
                        isDisabled: anyActionInFlight
                    ) {
                        updateChannelStatus(channelId: channel.id, status: "active")
                    }
                case "unverified", "pending":
                    VButton(
                        label: "Send Verification",
                        style: .primary,
                        size: .medium,
                        isDisabled: anyActionInFlight
                    ) {
                        initiateVerification(for: channel)
                    }
                    VButton(
                        label: "Revoke Access",
                        style: .danger,
                        size: .medium,
                        isDisabled: anyActionInFlight
                    ) {
                        updateChannelStatus(channelId: channel.id, status: "revoked")
                    }
                default:
                    VButton(
                        label: "Revoke Access",
                        style: .danger,
                        size: .medium,
                        isDisabled: anyActionInFlight
                    ) {
                        updateChannelStatus(channelId: channel.id, status: "revoked")
                    }
                    VButton(
                        label: "Block",
                        style: .danger,
                        size: .medium,
                        isDisabled: anyActionInFlight
                    ) {
                        updateChannelStatus(channelId: channel.id, status: "blocked")
                    }
                }

                if isThisChannel {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            // Verification feedback
            if verificationInProgress == channel.id {
                HStack(spacing: VSpacing.xs) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Sending verification code...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            }

            if verificationSuccessChannelId == channel.id {
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                        .font(.system(size: 12))
                    Text("Verification code sent")
                        .font(VFont.caption)
                        .foregroundColor(VColor.success)
                }
            }

            // Telegram bootstrap: the guardian needs to open a deep link before
            // a verification code can be delivered.
            if telegramBootstrapChannelId == channel.id, let urlString = telegramBootstrapUrl, let url = URL(string: urlString) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Ask your contact to open this link to start the Telegram chat:")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)

                    Button {
                        NSWorkspace.shared.open(url)
                    } label: {
                        HStack(spacing: VSpacing.xs) {
                            Image(systemName: "arrow.up.right.square")
                                .font(.system(size: 11))
                            Text("Open Telegram")
                                .font(VFont.caption)
                        }
                        .foregroundColor(VColor.accent)
                    }
                    .buttonStyle(.plain)
                    .onHover { hovering in
                        if hovering {
                            NSCursor.pointingHand.push()
                        } else {
                            NSCursor.pop()
                        }
                    }
                }
            }
        }
    }

    // MARK: - Guardian Verification Actions

    @ViewBuilder
    private func guardianVerificationActions(for channel: ContactChannelPayload) -> some View {
        if Self.guardianSupportedChannels.contains(channel.type), let store {
            let state = store.guardianChannelState(for: channel.type)
            let destinationBinding = Binding<String>(
                get: { guardianDestinationTexts[channel.type] ?? "" },
                set: { guardianDestinationTexts[channel.type] = $0 }
            )

            GuardianVerificationFlowView(
                state: state,
                countdownNow: $guardianCountdownNow,
                destinationText: destinationBinding,
                onStartOutbound: { dest in store.startOutboundGuardianVerification(channel: channel.type, destination: dest) },
                onResend: { store.resendOutboundGuardian(channel: channel.type) },
                onCancelOutbound: { store.cancelOutboundGuardian(channel: channel.type) },
                onRevoke: { store.revokeChannelGuardian(channel: channel.type) },
                onStartChallenge: { rebind in store.startChannelGuardianVerification(channel: channel.type, rebind: rebind) },
                onCancelChallenge: { store.cancelGuardianChallenge(channel: channel.type) },
                botUsername: store.telegramBotUsername,
                phoneNumber: store.twilioPhoneNumber,
                showLabel: false
            )
        }
        // Email and other unsupported channel types: show nothing (display-only)
    }

    // MARK: - Guardian Countdown Timer

    private func startGuardianCountdownTimer() {
        guard guardianCountdownTimer == nil else { return }
        guardianCountdownNow = Date()
        guardianCountdownTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            Task { @MainActor in
                guardianCountdownNow = Date()
            }
        }
    }

    private func stopGuardianCountdownTimer() {
        guardianCountdownTimer?.invalidate()
        guardianCountdownTimer = nil
    }

    // MARK: - Status Badge

    @ViewBuilder
    private func statusBadge(for channel: ContactChannelPayload) -> some View {
        let (label, bgColor, fgColor) = statusBadgeStyle(for: channel)

        Text(label)
            .font(VFont.captionMedium)
            .foregroundColor(fgColor)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xxs)
            .background(bgColor)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
    }

    private func statusBadgeStyle(for channel: ContactChannelPayload) -> (String, Color, Color) {
        if channel.status == "active" && channel.verifiedAt != nil {
            return ("Verified", VColor.accentSubtle, VColor.success)
        }
        switch channel.status {
        case "active":
            return ("Active", Color.blue.opacity(0.15), Color.blue)
        case "pending":
            return ("Pending", Color.yellow.opacity(0.15), VColor.warning)
        case "revoked":
            return ("Revoked", Color.red.opacity(0.15), VColor.error)
        case "blocked":
            return ("Blocked", Color.red.opacity(0.15), VColor.error)
        default:
            return ("Unverified", VColor.surfaceSubtle, VColor.textMuted)
        }
    }

    // MARK: - Formatting Helpers

    private func formatContactType(_ contactType: String?) -> String {
        switch contactType {
        case "assistant":
            return "Assistant"
        default:
            return "Human"
        }
    }

    // MARK: - Helpers

    private func channelIcon(for type: String) -> String {
        switch type {
        case "telegram":
            return "paperplane.fill"
        case "voice":
            return "phone.fill"
        case "sms":
            return "phone.fill"
        case "email":
            return "envelope.fill"
        case "whatsapp", "slack":
            return "bubble.left.fill"
        default:
            return "globe"
        }
    }

    private func channelLabel(for type: String) -> String {
        switch type {
        case "telegram": return "Telegram"
        case "sms": return "SMS"
        case "email": return "Email"
        case "voice": return "Voice"
        case "slack": return "Slack"
        default: return type.capitalized
        }
    }

    private func relativeTime(epochMs: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(epochMs) / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private func formatDate(epochMs: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(epochMs) / 1000)
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }

    // MARK: - Actions

    private func saveCardEdits() async {
        let isGuardian = displayContact.role == "guardian"
        let trimmedName = isGuardian ? displayContact.displayName : editedName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return }
        let trimmedNotes = editedNotes.trimmingCharacters(in: .whitespacesAndNewlines)

        let originalNotes = displayContact.notes ?? ""
        if trimmedName == displayContact.displayName && trimmedNotes == originalNotes {
            isEditing = false
            return
        }

        isSaving = true
        errorMessage = nil
        do {
            if let updated = try await daemonClient?.updateContact(
                contactId: displayContact.id,
                displayName: trimmedName,
                notes: trimmedNotes
            ) {
                currentContact = updated
                isEditing = false
            } else {
                errorMessage = "Failed to save changes"
            }
        } catch {
            errorMessage = "Failed to save: \(error.localizedDescription)"
        }
        isSaving = false
    }

    private func initiateVerification(for channel: ContactChannelPayload) {
        guard let daemonClient, verificationInProgress == nil else { return }
        verificationInProgress = channel.id
        errorMessage = nil
        verificationSuccessChannelId = nil
        telegramBootstrapUrl = nil
        telegramBootstrapChannelId = nil

        Task {
            do {
                let result = try await daemonClient.verifyContactChannel(
                    contactId: displayContact.id,
                    channelId: channel.id
                )
                if result?.ok == true {
                    // Telegram bootstrap: ok is true but no code was sent yet —
                    // the user needs to open the bootstrap URL first.
                    if let bootstrapUrl = result?.telegramBootstrapUrl {
                        telegramBootstrapUrl = bootstrapUrl
                        telegramBootstrapChannelId = channel.id
                    } else {
                        verificationSuccessChannelId = channel.id
                        // Auto-clear the success message after 5 seconds
                        Task {
                            try? await Task.sleep(nanoseconds: 5_000_000_000)
                            if verificationSuccessChannelId == channel.id {
                                verificationSuccessChannelId = nil
                            }
                        }
                    }
                } else {
                    errorMessage = result?.error ?? "Failed to send verification"
                }
            } catch {
                errorMessage = "Failed to send verification: \(error.localizedDescription)"
            }
            verificationInProgress = nil
        }
    }

    private func createInviteForChannel(type: String) {
        guard let daemonClient, inviteInProgress == nil else { return }
        inviteInProgress = type
        inviteError = nil
        inviteResult = nil
        Task {
            do {
                if let result = try await daemonClient.createInvite(
                    sourceChannel: type,
                    note: "Invite for \(displayContact.displayName)",
                    contactName: displayContact.displayName
                ) {
                    inviteResult = (
                        type: type,
                        token: result.token,
                        shareUrl: result.shareUrl,
                        inviteCode: result.inviteCode,
                        guardianInstruction: result.guardianInstruction,
                        channelHandle: result.channelHandle
                    )
                } else {
                    inviteError = "Failed to create invite"
                }
            } catch {
                inviteError = "Failed to create invite: \(error.localizedDescription)"
            }
            inviteInProgress = nil
        }
    }

    private func updateChannelStatus(channelId: String, status: String) {
        guard let daemonClient else { return }
        guard actionInProgress == nil else { return }
        actionInProgress = channelId
        errorMessage = nil

        Task {
            // Subscribe before sending so we don't miss fast daemon responses
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.sendUpdateContactChannel(channelId: channelId, status: status)
            } catch {
                errorMessage = "Failed to update channel: \(error.localizedDescription)"
                actionInProgress = nil
                return
            }

            for await message in stream {
                if case .contactsResponse(let response) = message {
                    if response.success {
                        // Refresh the contact data
                        try? daemonClient.sendGetContact(contactId: displayContact.id)
                    } else {
                        errorMessage = response.error ?? "Failed to update channel"
                        actionInProgress = nil
                        return
                    }
                    break
                }
            }

            // Wait for the refresh response
            for await message in stream {
                if case .contactsResponse(let response) = message {
                    if let updatedContact = response.contact {
                        currentContact = updatedContact
                    }
                    actionInProgress = nil
                    return
                }
            }

            actionInProgress = nil
        }
    }
}

// MARK: - Preview

#Preview {
    ZStack {
        VColor.background.ignoresSafeArea()
        ContactDetailView(
            contact: ContactPayload(
                id: "contact-1",
                displayName: "Alice Smith",
                role: "contact",
                notes: "Colleague, prefers casual tone. Responds within hours.",
                contactType: "human",
                lastInteraction: Date().timeIntervalSince1970 * 1000 - 3_600_000,
                interactionCount: 42,
                channels: [
                    ContactChannelPayload(
                        id: "ch-1",
                        type: "telegram",
                        address: "@alicesmith",
                        isPrimary: true,
                        status: "active",
                        policy: "allow",
                        verifiedAt: Int(Date().timeIntervalSince1970 * 1000) - 86_400_000,
                        verifiedVia: "telegram"
                    ),
                    ContactChannelPayload(
                        id: "ch-2",
                        type: "email",
                        address: "alice@example.com",
                        isPrimary: false,
                        status: "active",
                        policy: "allow"
                    ),
                    ContactChannelPayload(
                        id: "ch-3",
                        type: "sms",
                        address: "+1555123456",
                        isPrimary: false,
                        status: "revoked",
                        policy: "allow",
                        revokedReason: "User requested"
                    ),
                    ContactChannelPayload(
                        id: "ch-4",
                        type: "slack",
                        address: "#general",
                        isPrimary: false,
                        status: "pending",
                        policy: "restrict",
                        lastSeenAt: Int(Date().timeIntervalSince1970 * 1000) - 7_200_000
                    ),
                    ContactChannelPayload(
                        id: "ch-5",
                        type: "whatsapp",
                        address: "+1555987654",
                        isPrimary: false,
                        status: "unverified",
                        policy: "allow"
                    )
                ]
            )
        )
        .frame(width: 500, height: 700)
    }
    .preferredColorScheme(.dark)
}

import SwiftUI
import VellumAssistantShared

/// Detail view for a single contact, showing header info (including notes),
/// channels with verification status, and action buttons.
@MainActor
struct ContactDetailView: View {
    private static let allChannelTypes = ["telegram", "phone", "slack"]

    let contact: ContactPayload
    var daemonClient: DaemonClient?
    var contactClient: ContactClientProtocol = ContactClient()
    var channelClient: ChannelClientProtocol = ChannelClient()
    var store: SettingsStore?
    var onDelete: (() -> Void)?
    var onSelectAssistant: (() -> Void)?
    var guardianName: String?

    @State var currentContact: ContactPayload?
    @State private var showDeleteConfirmation = false
    @State private var isDeleting = false
    @State private var actionInProgress: String?
    @State var errorMessage: String?
    @State private var editedName = ""
    @State private var editedNotes = ""
    @FocusState private var isNameFocused: Bool
    @State private var isSaving = false
    @State private var verificationInProgress: String?
    @State private var verificationSuccessChannelId: String?
    @State private var telegramBootstrapUrl: String?
    @State private var telegramBootstrapChannelId: String?
    @State private var invitePhoneNumber = ""
    @State private var inviteInProgress: String?
    @State private var inviteCallInProgress = false
    @State private var inviteCallTriggered = false
    /// The invite ID for which the call was triggered, used to correlate
    /// async call completion with the currently displayed invite.
    @State private var inviteCallInviteId: String?
    @State private var inviteResult: (
        type: String,
        inviteId: String,
        token: String?,
        shareUrl: String?,
        inviteCode: String?,
        voiceCode: String?,
        guardianInstruction: String?,
        channelHandle: String?
    )?
    @State private var inviteError: String?
    @State private var inviteErrorChannel: String?
    @State private var inviteCopiedType: String?
    @State private var inviteExpanded: Set<String> = []
    @State private var inviteHandleInput = ""
    @State private var inviteCodeRevealed = false
    @State private var channelReadiness: [String: ChannelReadinessInfo] = [:]
    @State private var channelReadinessLoaded = false
    /// Monotonically increasing counter that correlates a verification attempt
    /// with its one-shot response / timeout so stale callbacks are ignored.
    @State private var verificationAttempt: UInt64 = 0
    /// In-flight timeout task for the current verification attempt.
    @State private var verificationTimeoutTask: Task<Void, Never>?
    /// In-flight task that clears the success animation checkmark.
    @State private var verificationSuccessAnimationTask: Task<Void, Never>?
    /// The previous verification callback captured when installing the one-shot
    /// handler, so it can be restored if the view disappears mid-verification.
    @State private var previousVerificationCallback: ((ChannelVerificationSessionResponseMessage) -> Void)?

    var displayContact: ContactPayload {
        currentContact ?? contact
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                headerSection
                    .padding(VSpacing.lg)
                    .vCard(radius: VRadius.lg, background: VColor.surfaceOverlay)

                GuardianChannelsDetailView(
                    contact: displayContact,
                    daemonClient: daemonClient,
                    store: store,
                    onSelectAssistant: onSelectAssistant,
                    showCardBorders: false
                )
                .padding(VSpacing.lg)
                .vCard(radius: VRadius.lg, background: VColor.surfaceOverlay)
            }
        }
        .confirmationDialog(
            "Delete \(displayContact.displayName)?",
            isPresented: $showDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                deleteContact()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will permanently delete this contact and all their channels. This action cannot be undone.")
        }
        .onChange(of: contact.id) { _, _ in
            currentContact = nil
            let name = contact.displayName
            editedName = (name == "New Contact") ? "" : name
            editedNotes = contact.notes ?? ""
            inviteCodeRevealed = false
            inviteHandleInput = ""
            inviteExpanded = []
            inviteResult = nil
            inviteError = nil
            inviteErrorChannel = nil
        }
        .onChange(of: contact) { _, _ in
            currentContact = nil
            let name = contact.displayName
            editedName = (name == "New Contact") ? "" : name
            editedNotes = contact.notes ?? ""
        }
        .onDisappear {
            verificationTimeoutTask?.cancel()
            verificationTimeoutTask = nil
            verificationSuccessAnimationTask?.cancel()
            verificationSuccessAnimationTask = nil
            // If a verification was in flight, restore the previous callback so
            // SettingsStore's handler isn't permanently lost.
            if verificationInProgress != nil {
                daemonClient?.onChannelVerificationSessionResponse = previousVerificationCallback
                previousVerificationCallback = nil
                verificationInProgress = nil
            }
        }
    }

    // MARK: - Header Section

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            headerTitle
            headerFields
            headerActions
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear {
            // Leave name empty for placeholder contacts so the placeholder text shows
            let name = displayContact.displayName
            let isNewContact = name == "New Contact"
            editedName = isNewContact ? "" : name
            editedNotes = displayContact.notes ?? ""
            if isNewContact {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    isNameFocused = true
                }
            }
        }
    }

    private var headerTitle: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack(spacing: VSpacing.sm) {
                    Text(displayContact.displayName)
                        .font(VFont.display)
                        .foregroundColor(VColor.contentDefault)
                    contactTypeBadge
                }
                Text("\(displayContact.interactionCount) interaction\(displayContact.interactionCount == 1 ? "" : "s")")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }
            Spacer()
            VButton(
                label: "Delete Contact",
                leftIcon: VIcon.trash.rawValue,
                style: .dangerGhost,
                isDisabled: isDeleting || actionInProgress != nil || verificationInProgress != nil
            ) {
                // Skip confirmation for empty/placeholder contacts
                if displayContact.displayName == "New Contact" && displayContact.channels.isEmpty && displayContact.interactionCount == 0 {
                    deleteContact()
                } else {
                    showDeleteConfirmation = true
                }
            }
        }
    }

    private var headerFields: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Name")
                    .font(VFont.inputLabel)
                    .foregroundColor(VColor.contentSecondary)
                VTextField(placeholder: "Give this human a name", text: $editedName)
                    .focused($isNameFocused)
            }

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Notes")
                    .font(VFont.inputLabel)
                    .foregroundColor(VColor.contentSecondary)
                VTextEditor(
                    placeholder: "Optional notes about the human which AI will take into account",
                    text: $editedNotes,
                    minHeight: 80,
                    maxHeight: 180
                )
            }
        }
    }

    private var headerActions: some View {
        HStack(spacing: VSpacing.sm) {
            VButton(label: "Save", style: .primary, isDisabled: isSaving || editedName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                Task { await saveCardEdits() }
            }
            if isSaving {
                ProgressView()
                    .controlSize(.small)
            }
        }
    }

    private var contactTypeBadge: some View {
        ContactTypeBadge(role: displayContact.role)
    }

    // MARK: - Channels Section

    private var channelsSection: some View {
        let channelsByType = Dictionary(
            grouping: displayContact.channels.filter { $0.status != "revoked" },
            by: { $0.type }
        )

        let visibleTypes = Self.allChannelTypes.filter { type in
            // Always show channels the contact already has configured
            channelsByType[type] != nil
                // Otherwise only show channels the assistant has successfully set up
                || channelReadiness[type]?.ready == true
        }

        return VStack(alignment: .leading, spacing: VSpacing.md) {
            if !channelReadinessLoaded && visibleTypes.isEmpty {
                channelSkeletonRows()
            } else if visibleTypes.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("No channels available")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.contentDefault)
                    Text("This contact does not have any channels configured yet. Channels will appear here once the assistant has them set up and the contact is invited.")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentTertiary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                channelsList(visibleTypes: visibleTypes, channelsByType: channelsByType)
            }

            if let errorMessage {
                VInlineMessage(errorMessage)
            }
        }
        .task {
            channelReadiness = await channelClient.fetchChannelReadiness()
            channelReadinessLoaded = true
        }
    }

    /// Flat channel rows inside a single bordered container.
    @ViewBuilder
    private func channelsList(
        visibleTypes: [String],
        channelsByType: [String: [ContactChannelPayload]]
    ) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Channels")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.contentEmphasized)
                Text("Set up different ways to interact with your Assistant")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }

            // Channel rows
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(visibleTypes.enumerated()), id: \.element) { typeIndex, type in
                    if let channels = channelsByType[type] {
                        // Configured channels — show one row per channel
                        ForEach(Array(channels.enumerated()), id: \.element.id) { channelIndex, channel in
                            configuredChannelRow(channel)

                            // Expanded invite/verification content below the row
                            channelActions(for: channel)

                            if typeIndex < visibleTypes.count - 1 || channelIndex < channels.count - 1 {
                                SettingsDivider()
                                    .padding(.vertical, VSpacing.sm)
                            }
                        }
                    } else {
                        // Unconfigured channel — show invite row or expanded invite content
                        if inviteExpanded.contains(type) {
                            unconfiguredChannelRowExpanded(type: type)
                        } else {
                            unconfiguredChannelRow(type: type)
                        }

                        if typeIndex < visibleTypes.count - 1 {
                            SettingsDivider()
                                .padding(.vertical, VSpacing.sm)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// A flat row for a configured/verified channel: icon + name/description + timestamp + action button.
    @ViewBuilder
    private func configuredChannelRow(_ channel: ContactChannelPayload) -> some View {
        let isVerified = channel.status == "active" && channel.verifiedAt != nil
        let iconColor = isVerified ? VColor.systemPositiveStrong : VColor.contentSecondary

        HStack(spacing: VSpacing.md) {
            VIconView(channelIcon(for: channel.type), size: 20)
                .foregroundColor(iconColor)
                .frame(width: 20, height: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(isVerified ? channel.address : channelLabel(for: channel.type))
                    .font(VFont.bodyBold)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(1)

                channelDescription(for: channel)
            }

            Spacer()

            if let verifiedAt = channel.verifiedAt, verifiedAt > 0 {
                Text(relativeTime(epochMs: Int(verifiedAt)))
                    .font(VFont.inputLabel)
                    .foregroundColor(VColor.contentTertiary)
            }

            channelActionButton(for: channel)
        }
    }

    /// Description text below the channel name in a configured row.
    @ViewBuilder
    private func channelDescription(for channel: ContactChannelPayload) -> some View {
        let isVerified = channel.status == "active" && channel.verifiedAt != nil

        if isVerified, let verifiedAt = channel.verifiedAt, verifiedAt > 0 {
            Text("Verified via \(channelLabel(for: channel.type)) \u{00B7} \(formatDate(epochMs: Int(verifiedAt)))")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.contentTertiary)
                .lineLimit(1)
        } else {
            Text(channelSubtitle(for: channel.type))
                .font(VFont.inputLabel)
                .foregroundColor(VColor.contentTertiary)
                .lineLimit(1)
        }
    }

    /// The trailing action button for a configured channel row.
    @ViewBuilder
    private func channelActionButton(for channel: ContactChannelPayload) -> some View {
        let anyActionInFlight = actionInProgress != nil || verificationInProgress != nil || isDeleting
        let isVerified = channel.status == "active" && channel.verifiedAt != nil

        if isVerified {
            VButton(label: "Disable", style: .dangerGhost, size: .compact, isDisabled: anyActionInFlight) {
                updateChannelStatus(channelId: channel.id, status: "revoked")
            }
        } else if channel.status == "unverified" || channel.status == "pending" {
            VButton(label: "Send Verification", style: .outlined, size: .compact, isDisabled: anyActionInFlight) {
                initiateVerification(for: channel)
            }
        } else if channel.status == "blocked" {
            VButton(label: "Restore", style: .outlined, size: .compact, isDisabled: anyActionInFlight) {
                updateChannelStatus(channelId: channel.id, status: "active")
            }
        } else {
            VButton(label: "Disable", style: .dangerGhost, size: .compact, isDisabled: anyActionInFlight) {
                updateChannelStatus(channelId: channel.id, status: "revoked")
            }
        }
    }

    /// A flat row for an unconfigured channel (not yet invited): dimmed icon + name + "Not Available" or "Invite".
    @ViewBuilder
    private func unconfiguredChannelRow(type: String) -> some View {
        let isReady = channelReadiness[type]?.ready == true

        HStack(spacing: VSpacing.md) {
            VIconView(channelIcon(for: type), size: 20)
                .foregroundColor(isReady ? VColor.contentSecondary : VColor.contentDisabled)
                .frame(width: 20, height: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(channelLabel(for: type))
                    .font(VFont.bodyBold)
                    .foregroundColor(isReady ? VColor.contentDefault : VColor.contentDisabled)
                    .lineLimit(1)

                Text(channelSubtitle(for: type))
                    .font(VFont.inputLabel)
                    .foregroundColor(isReady ? VColor.contentTertiary : VColor.contentDisabled)
                    .lineLimit(1)
            }

            Spacer()

            if isReady {
                VButton(label: "Invite", style: .outlined, size: .compact) {
                    inviteExpanded.insert(type)
                    if type == "telegram" || type == "slack" {
                        createInviteForChannel(type: type)
                    }
                }
                .accessibilityHint("\(channelLabel(for: type)) is not connected for this contact")
            } else {
                VBadge(label: "Not Available", tone: .neutral)
            }
        }
    }

    /// Expanded invite content for an unconfigured channel row.
    @ViewBuilder
    private func unconfiguredChannelRowExpanded(type: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Show the channel row header with a collapse action
            HStack(spacing: VSpacing.md) {
                VIconView(channelIcon(for: type), size: 20)
                    .foregroundColor(VColor.contentSecondary)
                    .frame(width: 20, height: 20)

                VStack(alignment: .leading, spacing: 2) {
                    Text(channelLabel(for: type))
                        .font(VFont.bodyBold)
                        .foregroundColor(VColor.contentDefault)
                        .lineLimit(1)

                    Text(channelSubtitle(for: type))
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.contentTertiary)
                        .lineLimit(1)
                }

                Spacer()
            }

            // Invite flow content
            unconfiguredChannelContent(type: type)
        }
    }



    @ViewBuilder
    private func unconfiguredChannelContent(type: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            if type == "telegram" || type == "slack" {
                // Two-stage invite flow for Telegram/Slack
                if inviteInProgress == type && inviteResult?.type != type {
                    // Stage 0: Loading while invite is being created
                    ProgressView()
                        .controlSize(.small)
                } else if let result = inviteResult, result.type == type {
                    // Stage 1: Show invite URL + handle input (invite created)
                    telegramSlackInviteContent(type: type)
                } else {
                    // Fallback: re-show Invite/Cancel if no result yet
                    HStack(spacing: VSpacing.sm) {
                        VButton(label: "Invite", style: .outlined, isDisabled: inviteInProgress != nil) {
                            createInviteForChannel(type: type)
                        }
                        VButton(label: "Cancel", style: .ghost) {
                            inviteExpanded.remove(type)
                            if inviteResult?.type == type {
                                inviteResult = nil
                            }
                            inviteError = nil
                            inviteErrorChannel = nil
                        }
                    }
                }

                // Inline error display so the message appears inside the channel card
                if let inviteError, inviteErrorChannel == type {
                    VInlineMessage(inviteError)
                }
            } else if type == "phone" {
                // Phone channel: code-based invite flow
                if inviteInProgress == type {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        if type == "phone" {
                            TextField("+1234567890", text: $invitePhoneNumber)
                                .font(VFont.mono)
                                .vInputStyle()
                        }
                        if inviteResult?.type != type {
                            HStack(spacing: VSpacing.sm) {
                                VButton(
                                    label: "Invite",
                                    style: .outlined,
                                    isDisabled: inviteInProgress != nil || (type == "phone" && invitePhoneNumber.trimmingCharacters(in: .whitespaces).isEmpty)
                                ) {
                                    createInviteForChannel(type: type)
                                }
                                VButton(label: "Cancel", style: .ghost) {
                                    inviteExpanded.remove(type)
                                    inviteError = nil
                                    inviteErrorChannel = nil
                                }
                            }
                        }
                    }
                }

                if inviteResult?.type == type {
                    inviteResultDisplay(for: type)
                }

                // Inline error display so the message appears inside the channel card
                if let inviteError, inviteErrorChannel == type {
                    VInlineMessage(inviteError)
                }
            }
        }
    }

    @ViewBuilder
    private func telegramSlackInviteContent(type: String) -> some View {
        let result = inviteResult!

        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Invite URL section (Telegram has a deep link; Slack shows channel handle)
            if let shareUrl = result.shareUrl {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Share this invite link:")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                    HStack(spacing: VSpacing.sm) {
                        let truncated = shareUrl.count > 40
                            ? String(shareUrl.prefix(40)) + "..."
                            : shareUrl
                        Text(truncated)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.contentDefault)
                            .textSelection(.enabled)
                        VButton(
                            label: inviteCopiedType == "\(type)-link" ? "Copied!" : "Copy Link",
                            icon: VIcon.copy.rawValue,
                            style: .outlined
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
                }
            } else if let channelHandle = result.channelHandle {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Your assistant's \(channelLabel(for: type)) handle:")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                    Text(channelHandle)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.contentDefault)
                        .textSelection(.enabled)
                }
            }

            // Handle input section
            // NOTE: The handle input is informational for this iteration. It lets the
            // guardian note which user they're inviting, but the value is not yet sent
            // to the backend. The invite is already created when the card expands (with
            // the shareable URL/code). Backend integration to proactively message the
            // contact via their handle is deferred to a future iteration.
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Or enter their \(channelLabel(for: type)) handle:")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentSecondary)
                TextField(type == "telegram" ? "@username" : "@display_name", text: $inviteHandleInput)
                    .font(VFont.mono)
                    .vInputStyle()
            }

            // Buttons: Send reveals the already-generated invite code (the invite
            // was created when the card expanded). Cancel collapses the section.
            HStack(spacing: VSpacing.sm) {
                VButton(label: "Send", style: .outlined) {
                    inviteCodeRevealed = true
                }
                .disabled(inviteHandleInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                VButton(label: "Cancel", style: .ghost) {
                    inviteExpanded.remove(type)
                    if inviteResult?.type == type {
                        inviteResult = nil
                    }
                    inviteError = nil
                    inviteErrorChannel = nil
                    inviteHandleInput = ""
                    inviteCodeRevealed = false
                }
            }

            // Stage 2: Show the invite code after "Send" is clicked
            if inviteCodeRevealed {
                if let instruction = result.guardianInstruction {
                    Text(instruction)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let inviteCode = result.inviteCode ?? result.voiceCode {
                    Text(inviteCode)
                        .font(VFont.inviteCode)
                        .foregroundColor(VColor.contentDefault)
                        .tracking(4)
                        .padding(.vertical, VSpacing.xs)

                    VButton(
                        label: inviteCopiedType == type ? "Copied!" : "Copy Code",
                        icon: VIcon.copy.rawValue,
                        style: .outlined
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
            }
        }
    }

    @ViewBuilder
    private func inviteResultDisplay(for type: String) -> some View {
        let result = inviteResult!

        if let inviteCode = result.inviteCode ?? result.voiceCode {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                if let instruction = result.guardianInstruction {
                    Text(instruction)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                // When a share URL is available, show it as a copyable row below the instruction
                if let shareUrl = result.shareUrl {
                    HStack(spacing: VSpacing.sm) {
                        let truncated = shareUrl.count > 30
                            ? String(shareUrl.prefix(30)) + "..."
                            : shareUrl
                        Text(truncated)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.contentSecondary)

                        VButton(
                            label: inviteCopiedType == "\(type)-link" ? "Copied!" : "Copy Link",
                            icon: VIcon.copy.rawValue,
                            style: .outlined
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
                } else if let channelHandle = result.channelHandle {
                    // For channels without a share URL,
                    // show the assistant's channel handle so it can be copied.
                    HStack(spacing: VSpacing.sm) {
                        Text(channelHandle)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.contentSecondary)

                        VButton(
                            label: inviteCopiedType == "\(type)-handle" ? "Copied!" : "Copy Address",
                            icon: VIcon.copy.rawValue,
                            style: .outlined
                        ) {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(channelHandle, forType: .string)
                            inviteCopiedType = "\(type)-handle"
                            Task {
                                try? await Task.sleep(nanoseconds: 2_000_000_000)
                                guard !Task.isCancelled else { return }
                                if inviteCopiedType == "\(type)-handle" {
                                    inviteCopiedType = nil
                                }
                            }
                        }
                    }
                }

                // Large monospaced invite code for readability
                Text(inviteCode)
                    .font(VFont.inviteCode)
                    .foregroundColor(VColor.contentDefault)
                    .tracking(4)
                    .padding(.vertical, VSpacing.xs)

                HStack(spacing: VSpacing.sm) {
                    VButton(
                        label: inviteCopiedType == type ? "Copied!" : "Copy Code",
                        icon: VIcon.copy.rawValue,
                        style: .outlined
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

                    if type == "phone", let result = inviteResult {
                        if inviteCallTriggered {
                            HStack(spacing: VSpacing.sm) {
                                VIconView(.circleCheck, size: 14)
                                    .foregroundColor(VColor.systemPositiveStrong)
                                Text("Call started")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.systemPositiveStrong)
                            }
                        } else {
                            VButton(
                                label: inviteCallInProgress ? "Calling..." : "Call \(displayContact.displayName)",
                                icon: VIcon.phoneCall.rawValue,
                                style: .primary,
                                isDisabled: inviteCallInProgress
                            ) {
                                triggerInviteCallAction(inviteId: result.inviteId)
                            }
                        }
                    }

                    VButton(label: "Cancel", style: .ghost) {
                        inviteExpanded.remove(type)
                        inviteResult = nil
                        inviteError = nil
                        inviteErrorChannel = nil
                    }
                }
            }
        } else if let shareableText = result.shareUrl ?? result.token {
            // Fallback: no invite code available, show raw token
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                HStack(spacing: VSpacing.sm) {
                    let truncated = shareableText.count > 20
                        ? String(shareableText.prefix(20)) + "..."
                        : shareableText
                    Text(truncated)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.contentSecondary)

                    VButton(
                        label: inviteCopiedType == type ? "Copied!" : "Copy",
                        icon: VIcon.copy.rawValue,
                        style: .outlined
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

                VButton(label: "Cancel", style: .ghost) {
                    inviteExpanded.remove(type)
                    inviteResult = nil
                    inviteError = nil
                    inviteErrorChannel = nil
                }
            }
        } else {
            // Fallback: invite was created but no displayable fields are available
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Invite created but no details available")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentSecondary)

                VButton(label: "Cancel", style: .ghost) {
                    inviteExpanded.remove(type)
                    inviteResult = nil
                    inviteError = nil
                    inviteErrorChannel = nil
                }
            }
        }
    }

    /// Inline feedback shown below a configured channel row when an action is in-flight.
    @ViewBuilder
    private func channelActions(for channel: ContactChannelPayload) -> some View {
        let isThisChannel = actionInProgress == channel.id

        if isThisChannel {
            HStack(spacing: VSpacing.xs) {
                ProgressView()
                    .controlSize(.small)
                Text("Updating...")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentSecondary)
            }
            .padding(.leading, 20 + VSpacing.md) // align with text, past icon
        }

        if verificationInProgress == channel.id {
            HStack(spacing: VSpacing.xs) {
                ProgressView()
                    .controlSize(.small)
                Text("Sending verification code...")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentSecondary)
            }
            .padding(.leading, 20 + VSpacing.md)
        }

        if verificationSuccessChannelId == channel.id {
            HStack(spacing: VSpacing.xs) {
                VIconView(.circleCheck, size: 12)
                    .foregroundColor(VColor.systemPositiveStrong)
                Text("Verification code sent")
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemPositiveStrong)
            }
            .padding(.leading, 20 + VSpacing.md)
        }

        // Telegram bootstrap: the guardian needs to open a deep link before
        // a verification code can be delivered.
        if telegramBootstrapChannelId == channel.id, let urlString = telegramBootstrapUrl, let url = URL(string: urlString) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Ask your contact to open this link to start the Telegram chat:")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)

                Button {
                    NSWorkspace.shared.open(url)
                } label: {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.externalLink, size: 11)
                        Text("Open Telegram")
                            .font(VFont.caption)
                    }
                    .foregroundColor(VColor.primaryBase)
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }
            .padding(.leading, 20 + VSpacing.md)
        }
    }

    // MARK: - Skeleton Loading

    private func channelSkeletonRows() -> some View {
        let channelTypes = ["slack", "telegram", "phone"]
        let configuredCount = channelTypes.filter { type in
            store?.channelSetupStatus[type] == "ready"
        }.count
        let rowCount = max(configuredCount, 1)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(0..<rowCount, id: \.self) { index in
                HStack(spacing: VSpacing.sm) {
                    VSkeletonBone(width: 16, height: 16, radius: VRadius.xs)
                    VSkeletonBone(width: 80, height: 14)
                    Spacer()
                    VSkeletonBone(width: 90, height: 28, radius: VRadius.md)
                }
                .frame(minHeight: 36)
                .padding(.vertical, VSpacing.sm)
                if index < rowCount - 1 {
                    SettingsDivider()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Helpers

    private func channelIcon(for type: String) -> VIcon {
        switch type {
        case "telegram":
            return .send
        case "phone":
            return .lock
        case "email":
            return .mail
        case "whatsapp":
            return .messageSquare
        case "slack":
            return .hash
        default:
            return .globe
        }
    }

    private func channelLabel(for type: String) -> String {
        switch type {
        case "telegram": return "Telegram"
        case "email": return "Email"
        case "whatsapp": return "WhatsApp"
        case "phone": return "Phone"
        case "slack": return "Slack"
        default: return type.capitalized
        }
    }

    private func channelSubtitle(for type: String) -> String {
        switch type {
        case "telegram": return "Message your assistant from Telegram"
        case "phone": return "Call or text your assistant via phone"
        case "slack": return "Message your assistant from Slack"
        default: return "Connect via \(type.capitalized)"
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
        let trimmedName = editedName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { return }
        let trimmedNotes = editedNotes.trimmingCharacters(in: .whitespacesAndNewlines)

        let originalNotes = displayContact.notes ?? ""
        if trimmedName == displayContact.displayName && trimmedNotes == originalNotes {
            return
        }

        isSaving = true
        errorMessage = nil
        do {
            if let updated = try await contactClient.updateContact(
                contactId: displayContact.id,
                displayName: trimmedName,
                notes: trimmedNotes
            ) {
                currentContact = updated
                editedName = updated.displayName
                editedNotes = updated.notes ?? ""
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

        // Bump the attempt counter so stale responses from previous attempts are ignored.
        verificationAttempt &+= 1
        let currentAttempt = verificationAttempt

        // Cancel any lingering timeout from a previous attempt.
        verificationTimeoutTask?.cancel()

        // Stash the previous callback so we can restore it after the one-shot response
        // or if the view disappears mid-verification.
        let previousCallback = daemonClient.onChannelVerificationSessionResponse
        previousVerificationCallback = previousCallback

        // Timeout task that restores the previous handler if the daemon never responds.
        verificationTimeoutTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            guard !Task.isCancelled else { return }
            // Ignore if a newer attempt has started since this timeout was scheduled.
            guard currentAttempt == verificationAttempt else { return }
            // Only clean up if this verification is still in progress (response hasn't arrived).
            guard verificationInProgress == channel.id else { return }
            daemonClient.onChannelVerificationSessionResponse = previousCallback
            previousVerificationCallback = nil
            errorMessage = "Verification timed out — please try again"
            verificationInProgress = nil
        }

        daemonClient.onChannelVerificationSessionResponse = { [self] response in
            // Ignore stale responses from a previous verification attempt.
            guard currentAttempt == verificationAttempt else { return }

            // Response arrived — cancel the timeout.
            verificationTimeoutTask?.cancel()
            verificationTimeoutTask = nil

            // Restore the previous handler after consuming this one-shot response.
            daemonClient.onChannelVerificationSessionResponse = previousCallback
            previousVerificationCallback = nil
            // Also forward to the previous handler so SettingsStore still processes it.
            previousCallback?(response)

            if response.success {
                if let bootstrapUrl = response.telegramBootstrapUrl {
                    telegramBootstrapUrl = bootstrapUrl
                    telegramBootstrapChannelId = channel.id
                } else {
                    verificationSuccessChannelId = channel.id
                    // Cancel any prior success animation task before starting a new one.
                    verificationSuccessAnimationTask?.cancel()
                    verificationSuccessAnimationTask = Task {
                        try? await Task.sleep(nanoseconds: 5_000_000_000)
                        guard !Task.isCancelled else { return }
                        if verificationSuccessChannelId == channel.id {
                            verificationSuccessChannelId = nil
                        }
                    }
                }
            } else {
                errorMessage = response.error ?? "Failed to send verification"
            }
            verificationInProgress = nil
        }

        do {
            try daemonClient.sendChannelVerificationSession(
                action: "create_session",
                purpose: "trusted_contact",
                contactChannelId: channel.id
            )
        } catch {
            verificationTimeoutTask?.cancel()
            verificationTimeoutTask = nil
            daemonClient.onChannelVerificationSessionResponse = previousCallback
            previousVerificationCallback = nil
            errorMessage = "Failed to send verification: \(error.localizedDescription)"
            verificationInProgress = nil
        }
    }

    private func createInviteForChannel(type: String) {
        guard inviteInProgress == nil else { return }
        inviteInProgress = type
        inviteError = nil
        inviteErrorChannel = nil
        inviteResult = nil
        inviteCallInProgress = false
        inviteCallTriggered = false
        inviteCallInviteId = nil
        inviteCodeRevealed = false
        inviteHandleInput = ""
        Task {
            do {
                var phoneNumber: String? = nil
                if type == "phone" {
                    let trimmed = invitePhoneNumber.trimmingCharacters(in: .whitespaces)
                    phoneNumber = trimmed.hasPrefix("+") ? trimmed : "+1\(trimmed)"
                }
                let resolvedGuardianName = type == "phone" ? (guardianName ?? "your guardian") : nil

                if let result = try await contactClient.createInvite(
                    sourceChannel: type,
                    note: "Invite for \(displayContact.displayName)",
                    maxUses: nil,
                    contactName: displayContact.displayName,
                    contactId: displayContact.id,
                    expectedExternalUserId: phoneNumber,
                    friendName: type == "phone" ? displayContact.displayName : nil,
                    guardianName: resolvedGuardianName
                ) {
                    inviteResult = (
                        type: type,
                        inviteId: result.inviteId,
                        token: result.token,
                        shareUrl: result.shareUrl,
                        inviteCode: result.inviteCode,
                        voiceCode: result.voiceCode,
                        guardianInstruction: result.guardianInstruction,
                        channelHandle: result.channelHandle
                    )
                } else {
                    inviteError = "Failed to create invite"
                    inviteErrorChannel = type
                }
            } catch {
                inviteError = "Failed to create invite: \(error.localizedDescription)"
                inviteErrorChannel = type
            }
            inviteInProgress = nil
        }
    }

    private func triggerInviteCallAction(inviteId: String) {
        guard !inviteCallInProgress else { return }
        inviteCallInProgress = true
        inviteCallInviteId = inviteId
        Task {
            do {
                let success = try await contactClient.triggerInviteCall(inviteId: inviteId)
                // Only apply success if the currently displayed invite still
                // matches the one we triggered the call for. If the user
                // switched to a different invite before this async request
                // returned, discard the stale result.
                guard inviteResult?.inviteId == inviteId else {
                    inviteCallInProgress = false
                    return
                }
                if success {
                    inviteCallTriggered = true
                } else {
                    inviteError = "Failed to initiate call"
                    inviteErrorChannel = "phone"
                }
            } catch {
                guard inviteResult?.inviteId == inviteId else {
                    inviteCallInProgress = false
                    return
                }
                inviteError = "Failed to initiate call: \(error.localizedDescription)"
                inviteErrorChannel = "phone"
            }
            inviteCallInProgress = false
        }
    }

    private func updateChannelStatus(channelId: String, status: String) {
        guard actionInProgress == nil else { return }
        actionInProgress = channelId
        errorMessage = nil

        Task {
            do {
                _ = try await contactClient.updateContactChannel(channelId: channelId, status: status, policy: nil, reason: nil)
                let refreshed = try await contactClient.fetchContact(contactId: displayContact.id)
                if let refreshed {
                    currentContact = refreshed
                }
            } catch {
                errorMessage = "Failed to update channel: \(error.localizedDescription)"
            }
            actionInProgress = nil
        }
    }

    private func deleteContact() {
        guard actionInProgress == nil, verificationInProgress == nil else { return }
        isDeleting = true
        errorMessage = nil

        Task {
            do {
                let success = try await contactClient.deleteContact(contactId: displayContact.id)
                if success {
                    onDelete?()
                } else {
                    errorMessage = "Failed to delete contact"
                }
            } catch {
                errorMessage = "Failed to delete contact: \(error.localizedDescription)"
            }
            isDeleting = false
        }
    }
}

// MARK: - Preview

#Preview {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
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

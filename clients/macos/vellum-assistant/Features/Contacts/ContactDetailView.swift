import SwiftUI
import VellumAssistantShared

/// Detail view for a single contact, showing header info (including notes),
/// channels with verification status, and action buttons.
@MainActor
struct ContactDetailView: View {
    private static let allChannelTypes = ["telegram", "phone", "slack"]

    let contact: ContactPayload
    var daemonClient: DaemonClient?
    var store: SettingsStore?
    var onDelete: (() -> Void)?
    var guardianName: String?

    @State var currentContact: ContactPayload?
    @State private var showDeleteConfirmation = false
    @State private var isDeleting = false
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
    @State private var invitePhoneNumber = ""
    @State private var inviteInProgress: String?
    @State private var inviteCallInProgress = false
    @State private var inviteCallTriggered = false
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
    @State private var channelReadiness: [String: DaemonClient.ChannelReadinessInfo] = [:]
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
                channelsSection
            }
            .padding(VSpacing.xl)
        }
        .background(VColor.surfaceOverlay)
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
            inviteCodeRevealed = false
            inviteHandleInput = ""
            inviteExpanded = []
            inviteResult = nil
            inviteError = nil
            inviteErrorChannel = nil
        }
        .onChange(of: contact) { _, _ in
            currentContact = nil
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
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                if isEditing {
                    TextField("Display name", text: $editedName)
                        .font(VFont.largeTitle)
                        .foregroundColor(VColor.contentDefault)
                        .textFieldStyle(.plain)
                        .onSubmit { Task { await saveCardEdits() } }
                } else {
                    Text(displayContact.displayName)
                        .font(VFont.largeTitle)
                        .foregroundColor(VColor.contentDefault)
                }

                Spacer()

                if isEditing {
                    HStack(spacing: VSpacing.sm) {
                        VButton(label: "Save", style: .primary, isDisabled: isSaving) {
                            Task { await saveCardEdits() }
                        }
                        Button {
                            isEditing = false
                        } label: {
                            Text("Cancel")
                                .font(VFont.captionMedium)
                                .foregroundColor(VColor.contentTertiary)
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
                        VIconView(.pencil, size: 12)
                            .foregroundColor(VColor.contentSecondary)
                    }
                    .buttonStyle(.plain)
                    .opacity(isHoveringHeader ? 1 : 0)
                    .animation(VAnimation.fast, value: isHoveringHeader)
                    .accessibilityLabel("Edit contact")

                    Button(action: { showDeleteConfirmation = true }) {
                        if isDeleting {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            VIconView(.trash, size: 14)
                                .foregroundColor(VColor.systemNegativeStrong)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(isDeleting || actionInProgress != nil || verificationInProgress != nil)
                    .help("Delete contact")
                    .opacity(isHoveringHeader ? 1 : 0)
                    .animation(VAnimation.fast, value: isHoveringHeader)
                    .accessibilityLabel("Delete contact")
                }
            }

            HStack(spacing: VSpacing.sm) {
                contactTypeBadge
                Text("\(displayContact.interactionCount) interaction\(displayContact.interactionCount == 1 ? "" : "s")")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                if let lastInteraction = displayContact.lastInteraction {
                    Text("\u{00B7}")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                    Text("Last \(relativeTime(epochMs: Int(lastInteraction)))")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
            }

            Divider().background(VColor.borderBase)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Notes")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentSecondary)

                if isEditing {
                    TextEditor(text: $editedNotes)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentDefault)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 60, maxHeight: 160)
                        .padding(VSpacing.xs)
                        .background(VColor.surfaceActive)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                } else if let notes = displayContact.notes, !notes.isEmpty {
                    Text(notes)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentDefault)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text("No notes")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentTertiary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceOverlay)
        .onHover { hovering in
            isHoveringHeader = hovering
        }
    }

    private var contactTypeBadge: some View {
        VBadge(
            style: .label(formatContactType(displayContact.contactType)),
            color: displayContact.contactType == "assistant"
                ? VColor.primaryBase
                : VColor.contentSecondary
        )
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
                // Still loading channel readiness — show a spinner instead of a
                // false "No channels available" message.
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading channels...")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentTertiary)
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .vCard(background: VColor.surfaceOverlay)
            } else if visibleTypes.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("No channels available")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.contentDefault)
                    Text("This contact does not have any channels configured yet. Channels will appear here once the assistant has them set up and the contact is invited.")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentTertiary)
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .vCard(background: VColor.surfaceOverlay)
            } else {
                ForEach(visibleTypes, id: \.self) { type in
                    SettingsCard(title: channelLabel(for: type), subtitle: channelSubtitle(for: type)) {
                        if let channels = channelsByType[type] {
                            ForEach(Array(channels.enumerated()), id: \.element.id) { channelIndex, channel in
                                channelRow(channel)
                                if channelIndex < channels.count - 1 {
                                    SettingsDivider()
                                }
                            }
                        } else {
                            if inviteExpanded.contains(type) {
                                unconfiguredChannelContent(type: type)
                            } else {
                                VButton(label: "Invite", style: .outlined) {
                                    inviteExpanded.insert(type)
                                    if type == "telegram" || type == "slack" {
                                        createInviteForChannel(type: type)
                                    }
                                }
                                .accessibilityHint("\(channelLabel(for: type)) is not connected for this contact")
                            }
                        }
                    }
                }
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
            }
        }
        .task {
            do {
                channelReadiness = try await daemonClient?.fetchChannelReadiness() ?? [:]
            } catch {
                // Channel readiness fetch failed — fall back to showing only
                // channels the contact already has configured (channelReadiness
                // stays empty so no unconfigured channel cards appear).
            }
            channelReadinessLoaded = true
        }
    }

    @ViewBuilder
    private func channelRow(_ channel: ContactChannelPayload) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                VIconView(channelIcon(for: channel.type), size: 14)
                    .foregroundColor(VColor.contentSecondary)
                    .frame(width: 20, alignment: .center)

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: VSpacing.sm) {
                        Text(channel.address)
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                            .lineLimit(1)

                        statusBadge(for: channel)
                    }

                    // Platform user ID with profile link
                    if channel.type == "telegram",
                       let externalUserId = channel.externalUserId,
                       !externalUserId.isEmpty {
                        HStack(spacing: 0) {
                            Text("Telegram ID: ")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                            if let url = URL(string: "https://web.telegram.org/a/#\(externalUserId)") {
                                Link(externalUserId, destination: url)
                                    .font(VFont.caption)
                                    .lineLimit(1)
                                    .pointerCursor()
                            } else {
                                Text(externalUserId)
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.contentTertiary)
                                    .lineLimit(1)
                            }
                        }
                    }

                    if channel.type == "slack",
                       let externalUserId = channel.externalUserId,
                       !externalUserId.isEmpty {
                        HStack(spacing: 0) {
                            Text("Slack ID: ")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                            if let teamId = store?.slackChannelTeamId,
                               !teamId.isEmpty,
                               let url = URL(string: "slack://user?team=\(teamId)&id=\(externalUserId)") {
                                Link(externalUserId, destination: url)
                                    .font(VFont.caption)
                                    .lineLimit(1)
                                    .pointerCursor()
                            } else {
                                Text(externalUserId)
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.contentTertiary)
                                    .lineLimit(1)
                            }
                        }
                    }

                    if let verifiedAt = channel.verifiedAt, verifiedAt > 0 {
                        let dateStr = formatDate(epochMs: verifiedAt)
                        Text("Verified on \(dateStr)")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                    }

                    if channel.policy != "allow" {
                        VBadge(
                            style: .label("Policy: \(channel.policy.capitalized)"),
                            color: VColor.systemNegativeHover
                        )
                    }
                }

                Spacer()
            }

            channelActions(for: channel)
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
                        VButton(label: "Cancel", style: .outlined) {
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
                    Text(inviteError)
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemNegativeStrong)
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
                                .textFieldStyle(.plain)
                                .padding(VSpacing.sm)
                                .background(VColor.surfaceActive)
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
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
                                VButton(label: "Cancel", style: .outlined) {
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
                    Text(inviteError)
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemNegativeStrong)
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
                    .textFieldStyle(.plain)
                    .padding(VSpacing.sm)
                    .background(VColor.surfaceActive)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            }

            // Buttons: Send reveals the already-generated invite code (the invite
            // was created when the card expanded). Cancel collapses the section.
            HStack(spacing: VSpacing.sm) {
                VButton(label: "Send", style: .outlined) {
                    inviteCodeRevealed = true
                }
                .disabled(inviteHandleInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                VButton(label: "Cancel", style: .outlined) {
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
                                Image(systemName: "checkmark.circle.fill")
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

                    VButton(label: "Cancel", style: .outlined) {
                        inviteExpanded.remove(type)
                        inviteResult = nil
                        inviteError = nil
                        inviteErrorChannel = nil
                    }
                }
            }
        } else if let shareableText = result.shareUrl ?? result.token {
            // Fallback: no invite code available, show raw token
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
        } else {
            // Fallback: invite was created but no displayable fields are available
            Text("Invite created but no details available")
                .font(VFont.caption)
                .foregroundColor(VColor.contentSecondary)
        }
    }

    @ViewBuilder
    private func channelActions(for channel: ContactChannelPayload) -> some View {
        // Disable ALL action buttons while any channel action is in-flight to
        // serialize updates and prevent response correlation mix-ups.
        let anyActionInFlight = actionInProgress != nil || verificationInProgress != nil || isDeleting
        let isThisChannel = actionInProgress == channel.id

        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                switch channel.status {
                case "blocked":
                    VButton(
                        label: "Restore Access",
                        style: .outlined,
                        isDisabled: anyActionInFlight
                    ) {
                        updateChannelStatus(channelId: channel.id, status: "active")
                    }
                case "unverified", "pending":
                    VButton(
                        label: "Send Verification",
                        style: .primary,
                        isDisabled: anyActionInFlight
                    ) {
                        initiateVerification(for: channel)
                    }
                    VButton(
                        label: "Revoke",
                        style: .dangerOutline,
                        isDisabled: anyActionInFlight
                    ) {
                        updateChannelStatus(channelId: channel.id, status: "revoked")
                    }
                default:
                    VButton(
                        label: "Revoke",
                        style: .dangerOutline,
                        isDisabled: anyActionInFlight
                    ) {
                        updateChannelStatus(channelId: channel.id, status: "revoked")
                    }
                    VButton(
                        label: "Block",
                        style: .dangerOutline,
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
                        .foregroundColor(VColor.contentSecondary)
                }
            }

            if verificationSuccessChannelId == channel.id {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.circleCheck, size: 12)
                        .foregroundColor(VColor.systemPositiveStrong)
                    Text("Verification code sent")
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemPositiveStrong)
                }
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
            }
        }
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
            return ("Verified", VColor.systemPositiveWeak, VColor.systemPositiveStrong)
        }
        switch channel.status {
        case "active":
            return ("Active", VColor.systemPositiveWeak, VColor.systemPositiveStrong)
        case "pending":
            return ("Pending", VColor.systemMidWeak, VColor.systemNegativeHover)
        case "revoked":
            return ("Revoked", VColor.systemNegativeWeak, VColor.systemNegativeStrong)
        case "blocked":
            return ("Blocked", VColor.systemNegativeWeak, VColor.systemNegativeStrong)
        default:
            return ("Unverified", VColor.surfaceOverlay, VColor.contentTertiary)
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

    private func channelIcon(for type: String) -> VIcon {
        switch type {
        case "telegram":
            return .send
        case "phone":
            return .phoneCall
        case "email":
            return .mail
        case "whatsapp", "slack":
            return .messageCircle
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
        guard let daemonClient, inviteInProgress == nil else { return }
        inviteInProgress = type
        inviteError = nil
        inviteErrorChannel = nil
        inviteResult = nil
        inviteCallInProgress = false
        inviteCallTriggered = false
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

                if let result = try await daemonClient.createInvite(
                    sourceChannel: type,
                    note: "Invite for \(displayContact.displayName)",
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
        guard let daemonClient, !inviteCallInProgress else { return }
        inviteCallInProgress = true
        Task {
            do {
                let success = try await daemonClient.triggerInviteCall(inviteId: inviteId)
                if success {
                    inviteCallTriggered = true
                } else {
                    inviteError = "Failed to initiate call"
                    inviteErrorChannel = "phone"
                }
            } catch {
                inviteError = "Failed to initiate call: \(error.localizedDescription)"
                inviteErrorChannel = "phone"
            }
            inviteCallInProgress = false
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

    private func deleteContact() {
        guard let daemonClient else { return }
        guard actionInProgress == nil, verificationInProgress == nil else { return }
        isDeleting = true
        errorMessage = nil

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.sendDeleteContact(contactId: displayContact.id)
            } catch {
                errorMessage = "Failed to delete contact: \(error.localizedDescription)"
                isDeleting = false
                return
            }

            for await message in stream {
                if case .contactsResponse(let response) = message {
                    if response.success {
                        onDelete?()
                    } else {
                        errorMessage = response.error ?? "Failed to delete contact"
                    }
                    isDeleting = false
                    return
                }
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


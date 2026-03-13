import Combine
import SwiftUI
import VellumAssistantShared

/// Detail view for a single contact, showing header info (including notes),
/// channels with verification status, and action buttons.
@MainActor
struct ContactDetailView: View {
    private static let allChannelTypes = ["telegram", "phone", "slack"]

    private static let verificationSupportedChannels: Set<String> = ["telegram", "phone", "slack"]

    /// Channels that support 6-digit code invites from this view. Voice invites
    /// require additional fields not available here, so they are excluded.
    private static let codeInviteChannels: Set<String> = ["telegram", "slack"]

    let contact: ContactPayload
    var daemonClient: DaemonClient?
    var store: SettingsStore?
    var onDelete: (() -> Void)?

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
    @State private var readinessFetchFailed = false
    @State private var verificationDestinationTexts: [String: String] = [:]
    @State private var verificationCountdownNow: Date = Date()
    @State private var verificationCountdownTimer: Timer?
    /// Incremented whenever SettingsStore publishes a change, forcing SwiftUI to
    /// re-evaluate channel verification state derived from the store.
    @State private var verificationStoreRevision: Int = 0
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
        // Read verificationStoreRevision so SwiftUI tracks it; the .onReceive
        // below increments it whenever SettingsStore publishes, forcing
        // re-evaluation of channel verification state.
        let _ = verificationStoreRevision

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
        .onAppear {
            currentContact = contact
            if contact.role == "guardian" {
                startVerificationCountdownTimer()
                // Refresh channel verification state for all supported channels
                // so the view shows current status even if the user hasn't visited
                // the Channels settings tab yet.
                for channel in Self.verificationSupportedChannels {
                    store?.refreshChannelVerificationStatus(channel: channel)
                }
            }
        }
        .onDisappear {
            stopVerificationCountdownTimer()
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
        .onReceive(store?.objectWillChange.map { _ in () }.eraseToAnyPublisher() ?? Empty().eraseToAnyPublisher()) { _ in
            verificationStoreRevision += 1
        }
    }

    // MARK: - Header Section

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                if isEditing && displayContact.role != "guardian" {
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
                        VButton(label: "Save", style: .primary, size: .medium, isDisabled: isSaving) {
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

                    if displayContact.role != "guardian" {
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
            }

            HStack(spacing: VSpacing.sm) {
                roleBadge
                contactTypeBadge
            }

            HStack(spacing: VSpacing.sm) {
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

    private var roleBadge: some View {
        Group {
            if displayContact.role == "guardian" {
                Text("Guardian")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.primaryBase)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xxs)
                    .background(VColor.systemPositiveWeak)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
            } else {
                Text("Contact")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.contentSecondary)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xxs)
                    .background(VColor.surfaceOverlay)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
            }
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
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Channels")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.contentDefault)

            let channelsByType = Dictionary(
                grouping: displayContact.channels,
                by: { $0.type }
            )
            let extraChannels = displayContact.channels.filter { !Self.allChannelTypes.contains($0.type) }

            let visibleTypes = Self.allChannelTypes.filter { type in
                // Always show channels the contact already has configured
                channelsByType[type] != nil
                    // Otherwise only show channels the assistant has successfully set up
                    || channelReadiness[type]?.ready == true
            }
            let lastVisibleType = visibleTypes.last
            let hasExtraChannels = !extraChannels.isEmpty

            ForEach(Array(Self.allChannelTypes.enumerated()), id: \.element) { _, type in
                if let channels = channelsByType[type] {
                    // Configured channel — always show
                    ForEach(Array(channels.enumerated()), id: \.element.id) { channelIndex, channel in
                        channelRow(channel)

                        if channelIndex < channels.count - 1 {
                            Divider().background(VColor.borderBase)
                        }
                    }

                    if type != lastVisibleType || hasExtraChannels {
                        Divider().background(VColor.borderBase)
                    }
                } else if channelReadiness[type]?.ready == true {
                    // Unconfigured but assistant has this channel set up — show
                    unconfiguredChannelRow(type: type)

                    if type != lastVisibleType || hasExtraChannels {
                        Divider().background(VColor.borderBase)
                    }
                }
            }

            ForEach(Array(extraChannels.enumerated()), id: \.element.id) { index, channel in
                channelRow(channel)

                if index < extraChannels.count - 1 {
                    Divider().background(VColor.borderBase)
                }
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
            }

            if let inviteError {
                Text(inviteError)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceOverlay)
        .task {
            do {
                channelReadiness = try await daemonClient?.fetchChannelReadiness() ?? [:]
                readinessFetchFailed = false
            } catch {
                readinessFetchFailed = true
            }
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

                    if let verifiedAt = channel.verifiedAt, verifiedAt > 0 {
                        let dateStr = formatDate(epochMs: verifiedAt)
                        let via = channel.verifiedVia ?? "unknown"
                        Text("Verified via \(via) on \(dateStr)")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                    }

                    if let lastSeenAt = channel.lastSeenAt, lastSeenAt > 0 {
                        Text("Last seen \(relativeTime(epochMs: lastSeenAt))")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                    }

                    if channel.policy != "allow" {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.shield, size: 10)
                            Text("Policy: \(channel.policy)")
                                .font(VFont.caption)
                        }
                        .foregroundColor(VColor.systemNegativeHover)
                    }
                }

                Spacer()
            }

            // Guardian contacts get the full channel verification flow; others get standard actions
            if displayContact.role == "guardian" {
                channelVerificationActions(for: channel)
            } else {
                channelActions(for: channel)
            }
        }
    }

    @ViewBuilder
    private func unconfiguredChannelRow(type: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                VIconView(channelIcon(for: type), size: 14)
                    .foregroundColor(VColor.contentSecondary)
                    .frame(width: 20, alignment: .center)

                Text(channelLabel(for: type))
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)

                if let handle = channelReadiness[type]?.channelHandle {
                    Text(handle)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.contentTertiary)
                        .lineLimit(1)
                }

                Spacer()

                Text("Not set up")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }

            // Guardian contacts get the full channel verification flow; others get invite button
            if displayContact.role == "guardian" {
                if Self.verificationSupportedChannels.contains(type), let store {
                    let state = store.channelVerificationState(for: type)
                    let destinationBinding = Binding<String>(
                        get: { verificationDestinationTexts[type] ?? "" },
                        set: { verificationDestinationTexts[type] = $0 }
                    )
                    ChannelVerificationFlowView(
                        state: state,
                        countdownNow: $verificationCountdownNow,
                        destinationText: destinationBinding,
                        onStartOutbound: { dest in store.startOutboundVerification(channel: type, destination: dest) },
                        onResend: { store.resendOutboundVerification(channel: type) },
                        onCancelOutbound: { store.cancelOutboundVerification(channel: type) },
                        onRevoke: { store.revokeChannelVerification(channel: type) },
                        onStartSession: { rebind in store.startChannelVerification(channel: type, rebind: rebind) },
                        onCancelSession: { store.cancelVerificationSession(channel: type) },
                        botUsername: store.telegramBotUsername,
                        phoneNumber: store.twilioPhoneNumber,
                        showLabel: false
                    )
                }
            } else if Self.codeInviteChannels.contains(type) {
                // Channels that support 6-digit code invites can be invited directly
                // from this view. Voice invites require additional fields (phone number,
                // friend/guardian names) that aren't available in this context.
                // Row visibility is already gated on channelReadiness[type]?.ready == true,
                // so no additional readiness check is needed here.
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
                } else if let channelHandle = result.channelHandle {
                    // For channels without a share URL (email, WhatsApp),
                    // show the assistant's channel handle so it can be copied.
                    HStack(spacing: VSpacing.sm) {
                        Text(channelHandle)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.contentSecondary)

                        VButton(
                            label: inviteCopiedType == "\(type)-handle" ? "Copied!" : "Copy Address",
                            icon: VIcon.copy.rawValue,
                            style: .secondary,
                            size: .medium
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

                VButton(
                    label: inviteCopiedType == type ? "Copied!" : "Copy Code",
                    icon: VIcon.copy.rawValue,
                    style: (result.shareUrl != nil || result.channelHandle != nil) ? .tertiary : .secondary,
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
                    .foregroundColor(VColor.contentSecondary)

                VButton(
                    label: inviteCopiedType == type ? "Copied!" : "Copy",
                    icon: VIcon.copy.rawValue,
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
        let anyActionInFlight = actionInProgress != nil || verificationInProgress != nil || isDeleting
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

    // MARK: - Channel Verification Actions

    @ViewBuilder
    private func channelVerificationActions(for channel: ContactChannelPayload) -> some View {
        if Self.verificationSupportedChannels.contains(channel.type), let store {
            let state = store.channelVerificationState(for: channel.type)
            let destinationBinding = Binding<String>(
                get: { verificationDestinationTexts[channel.type] ?? "" },
                set: { verificationDestinationTexts[channel.type] = $0 }
            )

            ChannelVerificationFlowView(
                state: state,
                countdownNow: $verificationCountdownNow,
                destinationText: destinationBinding,
                onStartOutbound: { dest in store.startOutboundVerification(channel: channel.type, destination: dest) },
                onResend: { store.resendOutboundVerification(channel: channel.type) },
                onCancelOutbound: { store.cancelOutboundVerification(channel: channel.type) },
                onRevoke: { store.revokeChannelVerification(channel: channel.type) },
                onStartSession: { rebind in store.startChannelVerification(channel: channel.type, rebind: rebind) },
                onCancelSession: { store.cancelVerificationSession(channel: channel.type) },
                botUsername: store.telegramBotUsername,
                phoneNumber: store.twilioPhoneNumber,
                showLabel: false
            )
        }
        // Email and other unsupported channel types: show nothing (display-only)
    }

    // MARK: - Verification Countdown Timer

    private func startVerificationCountdownTimer() {
        guard verificationCountdownTimer == nil else { return }
        verificationCountdownNow = Date()
        verificationCountdownTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            Task { @MainActor in
                verificationCountdownNow = Date()
            }
        }
    }

    private func stopVerificationCountdownTimer() {
        verificationCountdownTimer?.invalidate()
        verificationCountdownTimer = nil
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
        case "phone": return "Voice"
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


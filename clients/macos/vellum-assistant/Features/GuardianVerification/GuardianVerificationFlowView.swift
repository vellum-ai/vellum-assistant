import SwiftUI
import VellumAssistantShared

/// Reusable SwiftUI view that renders the full guardian verification flow for a single channel.
/// Supports all 5 states: destination input, sending, outbound pending (code/countdown/resend),
/// instruction pending (code/copy), and verified (identity/revoke).
///
/// Decoupled from SettingsStore — accepts state + action closures so it can be reused
/// in both the Channels preferences tab and the Contacts page guardian card.
struct GuardianVerificationFlowView: View {
    let state: GuardianChannelState
    @Binding var countdownNow: Date
    @Binding var destinationText: String

    // Action closures
    let onStartOutbound: (String) -> Void
    let onResend: () -> Void
    let onCancelOutbound: () -> Void
    let onRevoke: () -> Void
    let onStartChallenge: (Bool) -> Void
    let onCancelChallenge: () -> Void

    // Optional layout/display parameters
    var botUsername: String?
    var phoneNumber: String?
    var showLabel: Bool = true
    var labelColumnWidth: CGFloat = 140

    // MARK: - Copy Feedback State

    @State private var codeCopied: Bool = false
    @State private var commandCopied: Bool = false

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            stateContent

            if let error = state.error {
                errorView(error)
            }
        }
    }

    // MARK: - State Dispatch

    @ViewBuilder
    private var stateContent: some View {
        if state.verified {
            verifiedView
        } else if state.inProgress && state.outboundSessionId == nil {
            sendingView
        } else if state.outboundSessionId != nil {
            outboundPendingView
        } else if let instruction = state.instruction {
            instructionView(instruction: instruction)
        } else {
            destinationInputView
        }
    }

    // MARK: - Verified View

    private var verifiedView: some View {
        let primaryIdentity = state.primaryIdentity
        let secondaryIdentity = state.secondaryIdentity(primary: primaryIdentity)
        let telegramProfileURL: URL? = state.channel == "telegram"
            ? state.identity.flatMap { URL(string: "https://web.telegram.org/a/#\($0)") }
            : nil

        return VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                if showLabel {
                    guardianLabel
                }
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
            }
            VButton(label: "Revoke", style: .secondary) {
                onRevoke()
            }
        }
    }

    // MARK: - Sending Spinner View

    private var sendingView: some View {
        HStack(spacing: VSpacing.sm) {
            if showLabel {
                guardianLabel
            }
            ProgressView()
                .controlSize(.small)
            Text("Sending verification...")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
        }
    }

    // MARK: - Outbound Pending View

    private var outboundPendingView: some View {
        let canResend: Bool = {
            // Bootstrap sessions (Telegram handle-based) don't support resend
            if state.bootstrapUrl != nil { return false }
            guard let nextResendAt = state.outboundNextResendAt else { return true }
            return countdownNow >= nextResendAt
        }()
        let resendCooldownText: String? = {
            guard let nextResendAt = state.outboundNextResendAt,
                  countdownNow < nextResendAt else { return nil }
            let remaining = Int(nextResendAt.timeIntervalSince(countdownNow))
            return "Resend in \(remaining)s"
        }()

        return VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                if showLabel {
                    guardianLabel
                }
                Spacer()
            }

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                // Verification Code label + code box
                if let outboundCode = state.outboundCode {
                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(VColor.success)
                            .font(.system(size: 12))
                        Text("Verification Code Sent")
                            .font(VFont.caption)
                            .foregroundColor(VColor.success)
                    }

                    HStack(spacing: VSpacing.sm) {
                        Text(outboundCode)
                            .font(VFont.mono)
                            .foregroundColor(VColor.textPrimary)
                            .textSelection(.enabled)
                            .lineLimit(1)

                        Spacer()

                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(outboundCode, forType: .string)
                            codeCopied = true
                            // Use GCD instead of Task to avoid Swift concurrency executor
                            // tracking issues when the countdown timer rebuilds this view.
                            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                                codeCopied = false
                            }
                        } label: {
                            HStack(spacing: VSpacing.xs) {
                                Image(systemName: codeCopied ? "checkmark" : "doc.on.doc")
                                    .font(.system(size: 12, weight: .medium))
                                Text(codeCopied ? "Copied" : "Copy")
                                    .font(VFont.caption)
                            }
                            .foregroundColor(codeCopied ? VColor.success : VColor.textSecondary)
                            .frame(height: 28)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Copy verification code")
                        .help("Copy code")
                    }
                    .padding(VSpacing.md)
                    .frame(width: 360)
                    .background(VColor.surface)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                    )
                }

                // Send count + countdown in one line
                HStack(spacing: VSpacing.md) {
                    if state.outboundSendCount > 0 {
                        Text("Sent \(state.outboundSendCount) time\(state.outboundSendCount == 1 ? "" : "s")")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    if let expiresAt = state.outboundExpiresAt {
                        let remaining = expiresAt.timeIntervalSince(countdownNow)
                        if remaining > 0 {
                            let minutes = Int(remaining) / 60
                            let seconds = Int(remaining) % 60
                            Text("Expires in \(minutes):\(String(format: "%02d", seconds))")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        } else {
                            Text("Verification expired")
                                .font(VFont.caption)
                                .foregroundColor(VColor.error)
                        }
                    }
                }

                // Resend + Cancel in one line
                // Disable resend during bootstrap: when bootstrapUrl is set the session is
                // in pending_bootstrap state and the daemon rejects resend attempts.
                HStack(spacing: VSpacing.sm) {
                    VButton(label: resendCooldownText ?? "Resend", style: .secondary, isFullWidth: true) {
                        onResend()
                    }
                    .disabled(!canResend)
                    .frame(width: 160)

                    VButton(label: "Cancel", style: .tertiary) {
                        onCancelOutbound()
                    }
                }

                // Telegram bootstrap URL deep link
                if let bootstrapUrl = state.bootstrapUrl, let url = URL(string: bootstrapUrl) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Ask your guardian to open this link:")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)

                        Button {
                            NSWorkspace.shared.open(url)
                        } label: {
                            HStack(spacing: VSpacing.xs) {
                                Image(systemName: "arrow.up.right.square")
                                    .font(.system(size: 12))
                                Text("Open in Telegram")
                                    .font(VFont.caption)
                            }
                            .foregroundColor(VColor.accent)
                        }
                        .buttonStyle(.plain)
                        .onHover { hovering in
                            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Instruction View

    @ViewBuilder
    private func instructionView(instruction: String) -> some View {
        // All channels now use code-only verification. extractGuardianCommand
        // handles both "six-digit code: 123456" and "the code: <hex>" formats.
        let command: String? = extractGuardianCommand(from: instruction)
        let leadingPadding: CGFloat = showLabel ? labelColumnWidth + VSpacing.sm : 0

        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                if showLabel {
                    guardianLabel
                }
                Text("Verification pending")
                    .font(VFont.body)
                    .foregroundColor(VColor.warning)
                Spacer()
            }

            if let command {
                Text(guardianInstructionSubtext(
                    channel: state.channel,
                    botUsername: botUsername,
                    phoneNumber: phoneNumber
                ))
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .padding(.leading, leadingPadding)

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
                        commandCopied = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                            commandCopied = false
                        }
                    } label: {
                        HStack(spacing: VSpacing.xs) {
                            Image(systemName: commandCopied ? "checkmark" : "doc.on.doc")
                                .font(.system(size: 12, weight: .medium))
                            Text(commandCopied ? "Copied" : "Copy")
                                .font(VFont.caption)
                        }
                        .foregroundColor(commandCopied ? VColor.success : VColor.textSecondary)
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
                .padding(.leading, leadingPadding)
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
                    .padding(.leading, leadingPadding)
            }

            VButton(label: "Cancel", style: .tertiary) {
                onCancelChallenge()
            }
        }
    }

    // MARK: - Destination Input View

    private var destinationInputView: some View {
        let destination = destinationText.trimmingCharacters(in: .whitespacesAndNewlines)
        let placeholder = guardianDestinationPlaceholder(for: state.channel)

        return VStack(alignment: .leading, spacing: VSpacing.md) {
            if showLabel {
                guardianLabel
            }

            TextField(placeholder, text: $destinationText)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .frame(maxWidth: 360)

            if state.channel == "telegram" {
                HStack(spacing: 0) {
                    Text("Enter a @username or chat ID. ")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)

                    Button {
                        if let url = URL(string: "https://web.telegram.org/k/#@userinfobot") {
                            NSWorkspace.shared.open(url)
                        }
                    } label: {
                        Text("Find yours \u{2192}")
                            .font(VFont.caption)
                            .foregroundColor(VColor.accent)
                    }
                    .buttonStyle(.plain)
                    .onHover { hovering in
                        if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                    }
                }
            } else if state.channel == "voice" || state.channel == "sms" {
                Text("This is your personal phone number")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }

            VButton(label: "Send", style: .secondary) {
                onStartOutbound(destination)
            }
            .disabled(destination.isEmpty)
        }
    }

    // MARK: - Error View

    @ViewBuilder
    private func errorView(_ error: String) -> some View {
        let leadingPadding: CGFloat = showLabel ? labelColumnWidth + VSpacing.sm : 0

        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(error)
                .font(VFont.caption)
                .foregroundColor(VColor.error)
            if state.alreadyBound {
                VButton(label: "Replace", style: .secondary) {
                    onStartChallenge(true)
                }
            }
        }
        .padding(.leading, leadingPadding)
    }

    // MARK: - Guardian Label

    private var guardianLabel: some View {
        HStack(spacing: VSpacing.xs) {
            Text("Guardian Verification")
            VInfoTooltip("Guardian verification links your account identity for this channel.")
        }
        .font(VFont.caption)
        .foregroundColor(VColor.textSecondary)
        .frame(width: labelColumnWidth, alignment: .leading)
    }
}

// MARK: - Preview

#if DEBUG
struct GuardianVerificationFlowView_Previews: PreviewProvider {
    struct PreviewWrapper: View {
        @State private var countdownNow = Date()
        @State private var destinationText = ""

        let state: GuardianChannelState
        let title: String

        var body: some View {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text(title)
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.textMuted)
                GuardianVerificationFlowView(
                    state: state,
                    countdownNow: $countdownNow,
                    destinationText: $destinationText,
                    onStartOutbound: { _ in },
                    onResend: {},
                    onCancelOutbound: {},
                    onRevoke: {},
                    onStartChallenge: { _ in },
                    onCancelChallenge: {}
                )
            }
        }
    }

    static var previews: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            VStack(alignment: .leading, spacing: VSpacing.xl) {
                PreviewWrapper(
                    state: GuardianChannelState(
                        channel: "telegram",
                        identity: "123456789",
                        username: "guardian_user",
                        displayName: "Guardian User",
                        verified: true,
                        inProgress: false,
                        instruction: nil,
                        error: nil,
                        alreadyBound: false,
                        outboundSessionId: nil,
                        outboundExpiresAt: nil,
                        outboundNextResendAt: nil,
                        outboundSendCount: 0,
                        outboundCode: nil,
                        bootstrapUrl: nil
                    ),
                    title: "Verified (Telegram)"
                )

                PreviewWrapper(
                    state: GuardianChannelState(
                        channel: "telegram",
                        identity: nil,
                        username: nil,
                        displayName: nil,
                        verified: false,
                        inProgress: false,
                        instruction: nil,
                        error: nil,
                        alreadyBound: false,
                        outboundSessionId: "session-1",
                        outboundExpiresAt: Date().addingTimeInterval(300),
                        outboundNextResendAt: Date().addingTimeInterval(30),
                        outboundSendCount: 1,
                        outboundCode: "ABC123",
                        bootstrapUrl: nil
                    ),
                    title: "Outbound Pending"
                )

                PreviewWrapper(
                    state: GuardianChannelState(
                        channel: "telegram",
                        identity: nil,
                        username: nil,
                        displayName: nil,
                        verified: false,
                        inProgress: false,
                        instruction: "Please send the 6-digit code: 482910 to @vellum_bot",
                        error: nil,
                        alreadyBound: false,
                        outboundSessionId: nil,
                        outboundExpiresAt: nil,
                        outboundNextResendAt: nil,
                        outboundSendCount: 0,
                        outboundCode: nil,
                        bootstrapUrl: nil
                    ),
                    title: "Instruction Pending"
                )

                PreviewWrapper(
                    state: GuardianChannelState(
                        channel: "telegram",
                        identity: nil,
                        username: nil,
                        displayName: nil,
                        verified: false,
                        inProgress: false,
                        instruction: nil,
                        error: nil,
                        alreadyBound: false,
                        outboundSessionId: nil,
                        outboundExpiresAt: nil,
                        outboundNextResendAt: nil,
                        outboundSendCount: 0,
                        outboundCode: nil,
                        bootstrapUrl: nil
                    ),
                    title: "Destination Input"
                )
            }
            .padding(VSpacing.xl)
        }
        .frame(width: 500, height: 800)
        .previewDisplayName("GuardianVerificationFlowView")
    }
}
#endif

import SwiftUI
import VellumAssistantShared

/// Detail view for a single contact, showing header info, channels with
/// verification status, action buttons, and metadata.
@MainActor
struct ContactDetailView: View {
    let contact: ContactPayload
    var daemonClient: DaemonClient?

    @State private var currentContact: ContactPayload?
    @State private var actionInProgress: String?
    @State private var errorMessage: String?
    @State private var isEditingName = false
    @State private var editedName = ""
    @State private var isHoveringHeader = false

    // Metadata editing state
    @State private var isEditingRelationship = false
    @State private var editedRelationship = ""
    @State private var isEditingImportance = false
    @State private var editedImportance: Double = 0.5
    @State private var isEditingResponseExpectation = false
    @State private var editedResponseExpectation = ""
    @State private var isEditingPreferredTone = false
    @State private var editedPreferredTone = ""

    private var displayContact: ContactPayload {
        currentContact ?? contact
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                headerSection
                channelsSection
                metadataSection
            }
            .padding(VSpacing.xl)
        }
        .background(VColor.background)
        .onAppear {
            currentContact = contact
        }
    }

    // MARK: - Header Section

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            if isEditingName {
                HStack(spacing: VSpacing.sm) {
                    TextField("Display name", text: $editedName)
                        .font(VFont.largeTitle)
                        .foregroundColor(VColor.textPrimary)
                        .textFieldStyle(.plain)
                        .onSubmit { Task { await saveDisplayName() } }

                    Button {
                        Task { await saveDisplayName() }
                    } label: {
                        Image(systemName: "checkmark")
                            .foregroundColor(VColor.success)
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Save name")

                    Button {
                        isEditingName = false
                    } label: {
                        Image(systemName: "xmark")
                            .foregroundColor(VColor.textMuted)
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.escape, modifiers: [])
                    .accessibilityLabel("Cancel editing")
                }
            } else {
                HStack(spacing: VSpacing.sm) {
                    Text(displayContact.displayName)
                        .font(VFont.largeTitle)
                        .foregroundColor(VColor.textPrimary)

                    Button {
                        editedName = displayContact.displayName
                        isEditingName = true
                    } label: {
                        Image(systemName: "pencil")
                            .foregroundColor(VColor.textSecondary)
                            .font(.system(size: 12))
                    }
                    .buttonStyle(.plain)
                    .opacity(isHoveringHeader ? 1 : 0)
                    .animation(VAnimation.fast, value: isHoveringHeader)
                    .accessibilityLabel("Edit display name")
                }
            }

            HStack(spacing: VSpacing.sm) {
                roleBadge
            }
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

    // MARK: - Channels Section

    private var channelsSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Channels")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            if displayContact.channels.isEmpty {
                Text("No channels configured")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .padding(VSpacing.lg)
            } else {
                ForEach(displayContact.channels) { channel in
                    channelRow(channel)
                }
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
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

            // Action buttons for non-guardian channels
            if displayContact.role != "guardian" {
                channelActions(for: channel)
            }

            if channel.id != displayContact.channels.last?.id {
                Divider().background(VColor.divider)
            }
        }
    }

    @ViewBuilder
    private func channelActions(for channel: ContactChannelPayload) -> some View {
        // Disable ALL action buttons while any channel action is in-flight to
        // serialize updates and prevent response correlation mix-ups.
        let anyActionInFlight = actionInProgress != nil
        let isThisChannel = actionInProgress == channel.id

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

    // MARK: - Metadata Section

    private var metadataSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Metadata")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                metadataRow(
                    label: "Contact type",
                    value: formatContactType(displayContact.contactType)
                )

                editableRelationshipRow

                editableImportanceRow

                editableResponseExpectationRow

                editablePreferredToneRow

                metadataRow(
                    label: "Interactions",
                    value: "\(displayContact.interactionCount)"
                )

                if let lastInteraction = displayContact.lastInteraction {
                    metadataRow(
                        label: "Last interaction",
                        value: relativeTime(epochMs: Int(lastInteraction))
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Editable Metadata Rows

    private var editableRelationshipRow: some View {
        EditableMetadataRow(
            label: "Relationship",
            value: displayContact.relationship,
            isEditing: $isEditingRelationship,
            editor: {
                TextField("Relationship", text: $editedRelationship)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .textFieldStyle(.plain)
                    .onSubmit { Task { await saveRelationship() } }
            },
            onStartEditing: {
                editedRelationship = displayContact.relationship ?? ""
            },
            onCancel: {
                isEditingRelationship = false
            }
        )
    }

    private var editableImportanceRow: some View {
        HStack(spacing: VSpacing.sm) {
            Text("Importance")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .frame(width: 140, alignment: .leading)

            if isEditingImportance {
                HStack(spacing: VSpacing.sm) {
                    Slider(value: $editedImportance, in: 0...1, step: 0.1)
                        .frame(maxWidth: 160)

                    Text(String(format: "%.1f", editedImportance))
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                        .frame(width: 30, alignment: .trailing)

                    Button {
                        Task { await saveImportance() }
                    } label: {
                        Image(systemName: "checkmark")
                            .foregroundColor(VColor.success)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Save importance")

                    Button {
                        isEditingImportance = false
                    } label: {
                        Image(systemName: "xmark")
                            .foregroundColor(VColor.textMuted)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Cancel editing")
                }
            } else {
                Text(String(format: "%.1f", displayContact.importance))
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .onTapGesture {
                        editedImportance = displayContact.importance
                        isEditingImportance = true
                    }
            }

            Spacer()
        }
    }

    private var editableResponseExpectationRow: some View {
        HStack(spacing: VSpacing.sm) {
            Text("Response expectation")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .frame(width: 140, alignment: .leading)

            if isEditingResponseExpectation {
                HStack(spacing: VSpacing.sm) {
                    Picker("", selection: $editedResponseExpectation) {
                        Text("Immediate").tag("immediate")
                        Text("Within hours").tag("within_hours")
                        Text("Within a day").tag("within_day")
                        Text("Flexible").tag("flexible")
                        Divider()
                        Text("Clear").tag("")
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .onChange(of: editedResponseExpectation) { _, newValue in
                        Task { await saveResponseExpectation(newValue.isEmpty ? nil : newValue) }
                    }

                    Button {
                        isEditingResponseExpectation = false
                    } label: {
                        Image(systemName: "xmark")
                            .foregroundColor(VColor.textMuted)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Cancel editing")
                }
            } else if let expectation = displayContact.responseExpectation,
                      !expectation.isEmpty {
                Text(formatResponseExpectation(expectation))
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .onTapGesture {
                        editedResponseExpectation = expectation
                        isEditingResponseExpectation = true
                    }
            } else {
                Button {
                    editedResponseExpectation = ""
                    isEditingResponseExpectation = true
                } label: {
                    Text("+ Add")
                        .font(VFont.caption)
                        .foregroundColor(VColor.accent)
                }
                .buttonStyle(.plain)
            }

            Spacer()
        }
    }

    private var editablePreferredToneRow: some View {
        EditableMetadataRow(
            label: "Preferred tone",
            value: displayContact.preferredTone,
            isEditing: $isEditingPreferredTone,
            formatValue: { capitalizeFirst($0) },
            editor: {
                TextField("Preferred tone", text: $editedPreferredTone)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .textFieldStyle(.plain)
                    .onSubmit { Task { await savePreferredTone() } }
            },
            onStartEditing: {
                editedPreferredTone = displayContact.preferredTone ?? ""
            },
            onCancel: {
                isEditingPreferredTone = false
            }
        )
    }

    private func metadataRow(label: String, value: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .frame(width: 140, alignment: .leading)
            Text(value)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
            Spacer()
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

    private func formatResponseExpectation(_ value: String) -> String {
        switch value {
        case "immediate":
            return "Immediate"
        case "within_hours":
            return "Within hours"
        case "within_day":
            return "Within a day"
        case "flexible":
            return "Flexible"
        default:
            return capitalizeFirst(value.replacingOccurrences(of: "_", with: " "))
        }
    }

    private func capitalizeFirst(_ value: String) -> String {
        guard let first = value.first else { return value }
        return first.uppercased() + value.dropFirst()
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

    private func saveDisplayName() async {
        let trimmed = editedName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        errorMessage = nil

        do {
            if let updated = try await daemonClient?.updateContact(
                contactId: displayContact.id,
                displayName: trimmed
            ) {
                currentContact = updated
            }
            isEditingName = false
        } catch {
            errorMessage = "Failed to update name: \(error.localizedDescription)"
        }
    }

    private func saveMetadataField(
        relationship: String? = nil,
        importance: Double? = nil,
        responseExpectation: String? = nil,
        preferredTone: String? = nil
    ) async {
        errorMessage = nil
        do {
            if let updated = try await daemonClient?.updateContact(
                contactId: displayContact.id,
                displayName: displayContact.displayName,
                relationship: relationship,
                importance: importance,
                responseExpectation: responseExpectation,
                preferredTone: preferredTone
            ) {
                currentContact = updated
            }
        } catch {
            errorMessage = "Failed to update contact: \(error.localizedDescription)"
        }
    }

    private func saveRelationship() async {
        let trimmed = editedRelationship.trimmingCharacters(in: .whitespacesAndNewlines)
        await saveMetadataField(relationship: trimmed)
        isEditingRelationship = false
    }

    private func saveImportance() async {
        await saveMetadataField(importance: editedImportance)
        isEditingImportance = false
    }

    private func saveResponseExpectation(_ value: String?) async {
        await saveMetadataField(responseExpectation: value ?? "")
        isEditingResponseExpectation = false
    }

    private func savePreferredTone() async {
        let trimmed = editedPreferredTone.trimmingCharacters(in: .whitespacesAndNewlines)
        await saveMetadataField(preferredTone: trimmed)
        isEditingPreferredTone = false
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

// MARK: - EditableMetadataRow

/// A reusable row for editable text metadata fields. Shows the current value
/// (or a "+ Add" link when empty) and transforms into an inline editor on click.
private struct EditableMetadataRow<Editor: View>: View {
    let label: String
    let value: String?
    @Binding var isEditing: Bool
    var formatValue: (String) -> String = { $0 }
    @ViewBuilder let editor: () -> Editor
    let onStartEditing: () -> Void
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .frame(width: 140, alignment: .leading)

            if isEditing {
                HStack(spacing: VSpacing.sm) {
                    editor()

                    Button {
                        onCancel()
                    } label: {
                        Image(systemName: "xmark")
                            .foregroundColor(VColor.textMuted)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Cancel editing")
                }
            } else if let value, !value.isEmpty {
                Text(formatValue(value))
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .onTapGesture {
                        onStartEditing()
                        isEditing = true
                    }
            } else {
                Button {
                    onStartEditing()
                    isEditing = true
                } label: {
                    Text("+ Add")
                        .font(VFont.caption)
                        .foregroundColor(VColor.accent)
                }
                .buttonStyle(.plain)
            }

            Spacer()
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
                relationship: "colleague",
                importance: 0.8,
                responseExpectation: "within_hours",
                preferredTone: "casual",
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
                    )
                ]
            )
        )
        .frame(width: 500, height: 700)
    }
    .preferredColorScheme(.dark)
}

import SwiftUI
import VellumAssistantShared

/// A sheet displayed before sending logs, letting the user pick a reason
/// category, describe the issue, and provide an email for follow-up.
@MainActor
struct LogReportFormView: View {
    enum Field { case email, name, message }

    let authManager: AuthManager
    let initialReason: LogReportReason?
    let onSend: (LogReportFormData) -> Void
    let onCancel: () -> Void

    @State private var selectedReason: LogReportReason?
    @State private var name: String = ""
    @State private var message: String = ""
    @AppStorage("logReportEmail") private var email: String = ""
    @FocusState private var focusedField: Field?

    init(
        authManager: AuthManager,
        initialReason: LogReportReason? = nil,
        onSend: @escaping (LogReportFormData) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.authManager = authManager
        self.initialReason = initialReason
        self.onSend = onSend
        self.onCancel = onCancel
        self._selectedReason = State(initialValue: initialReason)
    }

    private var canSend: Bool {
        selectedReason != nil && !email.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            header
            reasonList
            emailField
            nameField
            messageField
            Spacer(minLength: 0)
            actionRow
        }
        .padding(VSpacing.xl)
        .background(VColor.surfaceOverlay)
        .frame(width: 480)
        .onAppear {
            if email.isEmpty, let userEmail = authManager.currentUser?.email {
                email = userEmail
            }
            if name.isEmpty, let displayName = authManager.currentUser?.display {
                name = displayName
            }
            if email.isEmpty {
                focusedField = .email
            } else if name.isEmpty {
                focusedField = .name
            } else {
                focusedField = .message
            }
        }
    }

    // MARK: - Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text("Send Logs")
                .font(VFont.headline)
                .foregroundColor(VColor.contentDefault)
            Text("Select a reason for your report so we can triage it faster.")
                .font(VFont.caption)
                .foregroundColor(VColor.contentSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var reasonList: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            ForEach(LogReportReason.allCases) { reason in
                ReasonRow(
                    reason: reason,
                    isSelected: selectedReason == reason,
                    action: { selectedReason = reason }
                )
            }
        }
    }

    private var nameField: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Name (optional)")
                .font(VFont.caption)
                .foregroundColor(VColor.contentSecondary)
            VTextField(
                placeholder: "Your name",
                text: $name,
                leadingIcon: VIcon.user.rawValue
            )
            .focused($focusedField, equals: .name)
        }
    }

    private var messageField: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("What happened?")
                .font(VFont.caption)
                .foregroundColor(VColor.contentSecondary)
            VTextEditor(
                placeholder: "Describe what happened...",
                text: $message,
                minHeight: 60,
                maxHeight: 80
            )
            .focused($focusedField, equals: .message)
        }
    }

    private var emailField: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Email")
                .font(VFont.caption)
                .foregroundColor(VColor.contentSecondary)
            VTextField(
                placeholder: "you@example.com",
                text: $email,
                leadingIcon: VIcon.mail.rawValue
            )
            .focused($focusedField, equals: .email)
        }
    }

    private var actionRow: some View {
        HStack {
            Spacer()
            VButton(label: "Cancel", style: .outlined) {
                onCancel()
            }
            VButton(
                label: "Send Logs",
                leftIcon: VIcon.send.rawValue,
                style: .primary,
                isDisabled: !canSend
            ) {
                guard let reason = selectedReason else { return }
                onSend(LogReportFormData(
                    reason: reason,
                    name: name,
                    message: message,
                    email: email
                ))
            }
        }
    }
}

// MARK: - Reason Row

private struct ReasonRow: View {
    let reason: LogReportReason
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: VSpacing.md) {
                VIconView(.resolve(reason.icon), size: 14)
                    .foregroundColor(isSelected ? VColor.primaryBase : VColor.contentSecondary)
                Text(reason.displayName)
                    .font(VFont.body)
                    .foregroundColor(isSelected ? VColor.contentDefault : VColor.contentSecondary)
                Spacer()
                if isSelected {
                    VIconView(.circleCheck, size: 14)
                        .foregroundColor(VColor.primaryBase)
                }
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isSelected ? VColor.surfaceActive : (isHovered ? VColor.surfaceActive.opacity(0.5) : Color.clear))
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(isSelected ? VColor.primaryBase.opacity(0.5) : Color.clear, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
        .buttonStyle(.plain)
        .onHover { hovering in isHovered = hovering }
        .pointerCursor()
        .accessibilityLabel(reason.displayName)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

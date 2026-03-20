import SwiftUI
import VellumAssistantShared

/// A sheet displayed before sending logs, letting the user pick a reason
/// category, describe the issue, and provide an email for follow-up.
@MainActor
struct LogReportFormView: View {
    enum Field { case email, message }

    let authManager: AuthManager
    let initialReason: LogReportReason?
    let onSend: (LogReportFormData) -> Void
    let onCancel: () -> Void

    @State private var selectedReason: LogReportReason?
    @State private var message: String = ""
    @AppStorage("logReportEmail") private var email: String = ""
    @State private var includeLogs: Bool = true
    @State private var hasManuallyToggledLogs: Bool = false
    @State private var logTimeRange: LogTimeRange = .pastHour
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
        if let reason = initialReason {
            self._includeLogs = State(initialValue: reason.isErrorCategory)
        }
    }

    private var canSend: Bool {
        selectedReason != nil && !email.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            header
            reasonList
            messageField
            logAttachmentSection
            emailField
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
            if email.isEmpty {
                focusedField = .email
            } else {
                focusedField = .message
            }
        }
        .onChange(of: selectedReason) { _, newReason in
            guard !hasManuallyToggledLogs, let reason = newReason else { return }
            includeLogs = reason.isErrorCategory
        }
    }

    // MARK: - Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text("Share Feedback")
                .font(VFont.headline)
                .foregroundColor(VColor.contentDefault)
            Text("Let us know what's going on.")
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

    @ViewBuilder
    private var logAttachmentSection: some View {
        if selectedReason != .featureRequest {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack(spacing: VSpacing.md) {
                    Toggle(isOn: Binding(
                        get: { includeLogs },
                        set: { newValue in
                            includeLogs = newValue
                            hasManuallyToggledLogs = true
                        }
                    )) {
                        Text("Include diagnostic logs")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentDefault)
                    }
                    .toggleStyle(.checkbox)

                    if includeLogs {
                        Picker("", selection: $logTimeRange) {
                            ForEach(LogTimeRange.allCases) { range in
                                Text(range.displayName).tag(range)
                            }
                        }
                        .pickerStyle(.menu)
                        .frame(width: 130)
                    }

                    Spacer()
                }

                Text("Logs include conversation messages and app diagnostics but never passwords or credentials.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(VSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(VColor.surfaceActive.opacity(0.3))
            )
        }
    }

    private var actionRow: some View {
        HStack {
            Spacer()
            VButton(label: "Cancel", style: .outlined) {
                onCancel()
            }
            VButton(
                label: "Submit",
                leftIcon: VIcon.send.rawValue,
                style: .primary,
                isDisabled: !canSend
            ) {
                guard let reason = selectedReason else { return }
                onSend(LogReportFormData(
                    reason: reason,
                    name: "",
                    message: message,
                    email: email,
                    includeLogs: includeLogs,
                    logTimeRange: logTimeRange
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

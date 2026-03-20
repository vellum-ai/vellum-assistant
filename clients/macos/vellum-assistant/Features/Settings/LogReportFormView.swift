import SwiftUI
import VellumAssistantShared

/// A sheet displayed for sharing feedback, letting the user pick a reason
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
        let effectiveReason = initialReason ?? .somethingBroken
        self._selectedReason = State(initialValue: effectiveReason)
        self._includeLogs = State(initialValue: effectiveReason.isErrorCategory)
    }

    private var canSend: Bool {
        selectedReason != nil && !email.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if shouldShowEmail {
                emailField
            }
            reasonCards
            messageField
            logAttachmentRow
            Spacer(minLength: 0)
            actionRow
        }
        .padding(VSpacing.xl)
        .background(VColor.surfaceOverlay)
        .frame(width: 480)
        .onAppear {
            if let userEmail = authManager.currentUser?.email {
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

    private var shouldShowEmail: Bool {
        authManager.currentUser?.email == nil
    }

    private var reasonCards: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Category")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.contentSecondary)
            ForEach(LogReportReason.allCases) { reason in
                ReasonCard(reason: reason, isSelected: selectedReason == reason) {
                    selectedReason = reason
                }
            }
        }
    }

    private var messageField: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("What happened?")
                .font(VFont.inputLabel)
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
        VTextField(
            "Email",
            placeholder: "you@example.com",
            text: $email,
            leadingIcon: VIcon.mail.rawValue
        )
        .focused($focusedField, equals: .email)
    }

    @ViewBuilder
    private var logAttachmentRow: some View {
        if selectedReason != .featureRequest {
            HStack(spacing: VSpacing.sm) {
                VToggle(
                    isOn: Binding(
                        get: { includeLogs },
                        set: { newValue in
                            includeLogs = newValue
                            hasManuallyToggledLogs = true
                        }
                    ),
                    label: "Include conversation logs"
                )

                if includeLogs {
                    VDropdown(
                        placeholder: "",
                        selection: $logTimeRange,
                        options: LogTimeRange.allCases.map { (label: $0.displayName, value: $0) },
                        size: .small,
                        maxWidth: 140
                    )
                }

                VInfoTooltip("Logs include conversation messages and app diagnostics but never passwords or credentials.")

                Spacer()
            }
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

private struct ReasonCard: View {
    let reason: LogReportReason
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: VSpacing.sm) {
                VIconView(.resolve(reason.icon), size: 14)
                    .foregroundColor(isSelected ? VColor.primaryBase : VColor.contentSecondary)
                Text(reason.displayName)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                Spacer()
                Circle()
                    .fill(isSelected ? VColor.primaryBase : Color.clear)
                    .frame(width: 8, height: 8)
                    .padding(4)
                    .overlay(
                        Circle()
                            .stroke(isSelected ? VColor.primaryBase : VColor.borderBase, lineWidth: 1.5)
                            .frame(width: 16, height: 16)
                    )
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isSelected ? VColor.primaryBase.opacity(0.08) : VColor.surfaceBase)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(isSelected ? VColor.primaryBase : VColor.borderBase, lineWidth: isSelected ? 1.5 : 1)
            )
        }
        .buttonStyle(.plain)
    }
}

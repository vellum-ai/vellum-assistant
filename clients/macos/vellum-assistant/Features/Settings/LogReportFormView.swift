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
            reasonDropdown
            messageField
            logAttachmentRow
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

    private var reasonDropdown: some View {
        VDropdown(
            "Category",
            placeholder: "Select a category\u{2026}",
            selection: $selectedReason,
            options: LogReportReason.allCases.map { (label: $0.displayName, value: Optional($0)) },
            emptyValue: .some(nil),
            optionIcon: { $0.flatMap { .resolve($0.icon) } }
        )
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
                Toggle(isOn: Binding(
                    get: { includeLogs },
                    set: { newValue in
                        includeLogs = newValue
                        hasManuallyToggledLogs = true
                    }
                )) {
                    Text("Include diagnostic logs")
                        .font(VFont.body)
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

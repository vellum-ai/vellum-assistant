import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

/// A sheet displayed for sharing feedback, letting the user pick a reason
/// category, describe the issue, and provide an email for follow-up.
@MainActor
struct LogReportFormView: View {
    enum Field { case email, message }

    let authManager: AuthManager
    let initialReason: LogReportReason?
    let onSend: (LogReportFormData) async throws -> Void
    let onCancel: () -> Void

    @State private var selectedReason: LogReportReason?
    @State private var message: String = ""
    @AppStorage("logReportEmail") private var email: String = ""
    @State private var includeLogs: Bool = true
    @State private var hasManuallyToggledLogs: Bool = false
    @State private var logTimeRange: LogTimeRange = .pastHour
    @State private var attachments: [URL] = []
    @State private var isSubmitting: Bool = false
    @FocusState private var focusedField: Field?

    private let maxAttachments = 10
    private let maxAttachmentBytes = 50 * 1024 * 1024

    private var allowedFileTypes: [UTType] {
        var types: [UTType] = [.png, .jpeg, .gif, .webP, .mpeg4Movie, .quickTimeMovie]
        if let webm = UTType(filenameExtension: "webm") {
            types.append(webm)
        }
        return types
    }

    init(
        authManager: AuthManager,
        initialReason: LogReportReason? = nil,
        onSend: @escaping (LogReportFormData) async throws -> Void,
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
        selectedReason != nil && !email.isEmpty && !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if shouldShowEmail {
                emailField
            }
            reasonCards
            messageField
            logAttachmentRow
            attachmentSection
            Spacer(minLength: 0)
            actionRow
        }
        .padding(VSpacing.xl)
        .background(VColor.surfaceOverlay)
        .frame(width: 480)
        .allowsHitTesting(!isSubmitting)
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
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            for provider in providers {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    let ext = url.pathExtension.lowercased()
                    let allowedExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "mp4", "mov", "webm"]
                    guard allowedExtensions.contains(ext) else { return }
                    guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
                          let size = attrs[.size] as? Int,
                          size <= maxAttachmentBytes else { return }
                    Task { @MainActor in
                        guard attachments.count < maxAttachments,
                              !attachments.contains(url) else { return }
                        attachments.append(url)
                    }
                }
            }
            return true
        }
    }

    // MARK: - Sections

    private var shouldShowEmail: Bool {
        authManager.currentUser?.email?.isEmpty != false
    }

    private var reasonCards: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Category")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
            ForEach(LogReportReason.allCases) { reason in
                ReasonCard(reason: reason, isSelected: selectedReason == reason) {
                    selectedReason = reason
                }
            }
        }
        .opacity(isSubmitting ? 0.5 : 1)
    }

    private var messageField: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("What happened?")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
            VTextEditor(
                placeholder: "Describe what happened...",
                text: $message,
                minHeight: 60,
                maxHeight: 80
            )
            .focused($focusedField, equals: .message)
        }
        .opacity(isSubmitting ? 0.5 : 1)
    }

    private var emailField: some View {
        VTextField(
            "Email",
            placeholder: "you@example.com",
            text: $email,
            leadingIcon: VIcon.mail.rawValue
        )
        .focused($focusedField, equals: .email)
        .opacity(isSubmitting ? 0.5 : 1)
    }

    @ViewBuilder
    private var attachmentSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(alignment: .center) {
                Text("Attachments")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
                if !attachments.isEmpty {
                    Text("·")
                        .foregroundStyle(VColor.contentTertiary)
                    Text("\(attachments.count)/\(maxAttachments)")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
                Spacer()
                VButton(
                    label: "Add files",
                    leftIcon: VIcon.paperclip.rawValue,
                    style: .outlined,
                    size: .compact
                ) {
                    openFilePicker()
                }
                .disabled(attachments.count >= maxAttachments)
            }

            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: VSpacing.sm) {
                        ForEach(attachments, id: \.absoluteString) { url in
                            AttachmentThumbnailView(url: url) {
                                attachments.removeAll { $0 == url }
                            }
                        }
                    }
                }
            }
        }
        .opacity(isSubmitting ? 0.5 : 1)
    }

    private func openFilePicker() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = allowedFileTypes
        panel.begin { response in
            guard response == .OK else { return }
            let remaining = maxAttachments - attachments.count
            guard remaining > 0 else { return }
            let eligible = panel.urls.filter { url in
                guard !attachments.contains(url) else { return false }
                guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
                      let size = attrs[.size] as? Int,
                      size <= maxAttachmentBytes else { return false }
                return true
            }
            for url in eligible.prefix(remaining) {
                attachments.append(url)
            }
        }
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
                        maxWidth: 140
                    )
                }

                VInfoTooltip("Logs include conversation messages and app diagnostics but never passwords or credentials.")

                Spacer()
            }
            .opacity(isSubmitting ? 0.5 : 1)
        }
    }

    private var actionRow: some View {
        HStack {
            Spacer()
            if isSubmitting {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Sending feedback…")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                }
            } else {
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
                    isSubmitting = true
                    Task {
                        do {
                            try await onSend(LogReportFormData(
                                reason: reason,
                                name: "",
                                message: message,
                                email: email,
                                includeLogs: includeLogs,
                                logTimeRange: logTimeRange,
                                attachments: attachments
                            ))
                        } catch {
                            isSubmitting = false
                        }
                    }
                }
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
                    .foregroundStyle(isSelected ? VColor.primaryBase : VColor.contentSecondary)
                Text(reason.displayName)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
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
                    .accessibilityHidden(true)
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
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

import SwiftUI
import VellumAssistantShared

/// Card for the Email service in the Models & Services settings tab.
///
/// Displays the assistant's email address (or a not-configured state),
/// a copy-to-clipboard button, and channel readiness status.
///
/// Currently email is managed-only (platform-hosted Mailgun). The
/// Managed/Your Own toggle is intentionally omitted until BYO email
/// support is available.
@MainActor
struct EmailServiceCard: View {
    @ObservedObject var store: SettingsStore

    @State private var emailCopied: Bool = false

    var body: some View {
        SettingsCard(
            title: "Email",
            subtitle: "Send and receive emails as your assistant"
        ) {
            if let email = store.assistantEmail {
                configuredContent(email: email)
            } else {
                notConfiguredContent
            }
        }
    }

    // MARK: - Configured

    @ViewBuilder
    private func configuredContent(email: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Status row
            HStack(spacing: VSpacing.sm) {
                VIconView(.circleCheck, size: 14)
                    .foregroundStyle(VColor.systemPositiveStrong)
                Text("Connected")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.systemPositiveStrong)
            }

            // Email address row with copy button
            HStack(spacing: VSpacing.sm) {
                VIconView(.mail, size: 14)
                    .foregroundStyle(VColor.contentSecondary)
                Text(email)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .textSelection(.enabled)
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(email, forType: .string)
                    emailCopied = true
                    Task {
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                        emailCopied = false
                    }
                } label: {
                    VIconView(emailCopied ? .check : .copy, size: 12)
                        .foregroundStyle(emailCopied ? VColor.systemPositiveStrong : VColor.contentSecondary)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy email address")
                .help("Copy email address")
            }

            // Mode indicator
            HStack(spacing: VSpacing.sm) {
                Text("Mode")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                Text("Managed")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
            }
        }
    }

    // MARK: - Not Configured

    private var notConfiguredContent: some View {
        VNotification(
            "Not configured — ask your assistant to set up email, or run `assistant email setup` from the CLI.",
            tone: .warning
        )
    }
}

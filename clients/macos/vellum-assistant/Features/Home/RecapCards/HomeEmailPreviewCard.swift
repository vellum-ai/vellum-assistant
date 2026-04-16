import SwiftUI
import VellumAssistantShared

/// Recap card that previews a drafted email with to/subject/body
/// fields and Send / Rework action buttons.
struct HomeEmailPreviewCard: View {

    let title: String
    let threadName: String?
    let toAddress: String
    let subject: String
    let bodyText: String
    let showDismiss: Bool
    let onSend: () -> Void
    let onRework: () -> Void
    let onDismiss: (() -> Void)?

    init(
        title: String,
        threadName: String? = nil,
        toAddress: String,
        subject: String,
        bodyText: String,
        showDismiss: Bool = false,
        onSend: @escaping () -> Void,
        onRework: @escaping () -> Void,
        onDismiss: (() -> Void)? = nil
    ) {
        self.title = title
        self.threadName = threadName
        self.toAddress = toAddress
        self.subject = subject
        self.bodyText = bodyText
        self.showDismiss = showDismiss
        self.onSend = onSend
        self.onRework = onRework
        self.onDismiss = onDismiss
    }

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            HomeRecapCardHeader(
                icon: .mail,
                title: title,
                subtitle: threadName,
                showDismiss: showDismiss,
                onDismiss: onDismiss
            )

            emailContentArea

            actionButtons
        }
        .recapCardGlass()
        .recapCardMaxWidth()
    }

    // MARK: - Email Content Area

    private var emailContentArea: some View {
        VStack(spacing: 0) {
            emailField(label: "To:", value: toAddress)
            divider
            emailField(label: "Subject:", value: subject)
            divider
            bodySection
        }
        .padding(VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.xxl, style: .continuous)
                .fill(VColor.surfaceOverlay)
        )
    }

    private func emailField(label: String, value: String) -> some View {
        HStack(spacing: VSpacing.xs) {
            Text(label)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)

            Text(value)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)
                .lineLimit(1)

            Spacer(minLength: 0)
        }
        .padding(.vertical, VSpacing.sm)
    }

    private var bodySection: some View {
        HStack {
            Text(bodyText)
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentDefault)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, VSpacing.sm)
    }

    private var divider: some View {
        Rectangle()
            .fill(VColor.surfaceBase)
            .frame(height: 1)
    }

    // MARK: - Action Buttons

    private var actionButtons: some View {
        HStack(spacing: VSpacing.sm) {
            Button(action: onSend) {
                Text("Send it")
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentInset)
                    .frame(maxWidth: .infinity)
                    .frame(height: 32)
                    .background(
                        Capsule()
                            .fill(VColor.primaryBase)
                    )
            }
            .buttonStyle(.plain)

            Button(action: onRework) {
                Text("Rework")
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.primaryBase)
                    .frame(maxWidth: .infinity)
                    .frame(height: 32)
                    .background(
                        Capsule()
                            .strokeBorder(VColor.borderElement, lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)
        }
    }
}

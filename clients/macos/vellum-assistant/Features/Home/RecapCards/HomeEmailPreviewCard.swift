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
    let onSend: () -> Void
    let onRework: () -> Void
    let onDismiss: (() -> Void)?

    init(
        title: String,
        threadName: String? = nil,
        toAddress: String,
        subject: String,
        bodyText: String,
        onSend: @escaping () -> Void,
        onRework: @escaping () -> Void,
        onDismiss: (() -> Void)? = nil
    ) {
        self.title = title
        self.threadName = threadName
        self.toAddress = toAddress
        self.subject = subject
        self.bodyText = bodyText
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
                showDismiss: true,
                onDismiss: onDismiss
            )

            emailContentArea

            actionButtons
        }
        .glassCard()
        .recapCardMaxWidth(fill: true)
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
        Text("\(label) \(value)")
            .font(VFont.bodyMediumDefault)
            .foregroundStyle(VColor.contentSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, VSpacing.sm)
    }

    private var bodySection: some View {
        Text(bodyText)
            .font(VFont.bodyMediumEmphasised)
            .foregroundStyle(VColor.contentDefault)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, VSpacing.sm)
    }

    private var divider: some View {
        Rectangle()
            .fill(VColor.surfaceBase)
            .frame(height: 1)
    }

    // MARK: - Action Buttons

    private var actionButtons: some View {
        HStack(spacing: VSpacing.xs) {
            VButton(label: "Send it", style: .primary, size: .pillRegular, action: onSend)
            VButton(label: "Rework", style: .outlined, size: .pillRegular, action: onRework)
            Spacer(minLength: 0)
        }
    }
}

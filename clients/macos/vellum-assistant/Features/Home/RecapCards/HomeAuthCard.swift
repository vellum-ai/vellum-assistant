import SwiftUI
import VellumAssistantShared

/// Card for payment authorisation actions. Supports two layouts:
/// - **Simple**: title + Authorise/Deny buttons in a single row.
/// - **Rich**: title + subtitle + Authorise/Deny/Dismiss buttons,
///   with an optional file attachment row below.
struct HomeAuthCard: View {
    let title: String
    let subtitle: String?
    let attachment: (fileName: String, fileSize: String)?
    let onAuthorise: () -> Void
    let onDeny: () -> Void
    let onDismiss: (() -> Void)?

    init(
        title: String,
        subtitle: String? = nil,
        attachment: (fileName: String, fileSize: String)? = nil,
        onAuthorise: @escaping () -> Void,
        onDeny: @escaping () -> Void,
        onDismiss: (() -> Void)? = nil
    ) {
        self.title = title
        self.subtitle = subtitle
        self.attachment = attachment
        self.onAuthorise = onAuthorise
        self.onDeny = onDeny
        self.onDismiss = onDismiss
    }

    private var isSimple: Bool {
        subtitle == nil && attachment == nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            headerRow
            if let attachment {
                HomeLinkFileRow(
                    icon: .file,
                    fileName: attachment.fileName,
                    fileSize: attachment.fileSize
                )
            }
        }
        .if(isSimple) { view in
            view.glassCard(shape: Capsule())
        }
        .if(!isSimple) { view in
            view.glassCard()
        }
        .recapCardMaxWidth()
    }

    // MARK: - Header

    private var headerRow: some View {
        HStack(spacing: VSpacing.lg) {
            HStack(spacing: VSpacing.sm) {
                iconCircle
                titleStack
            }
            actionButtons
        }
    }

    // MARK: - Icon

    private var iconCircle: some View {
        ZStack {
            Circle()
                .fill(VColor.surfaceLift)
                .frame(width: 38, height: 38)
            VIconView(.file, size: 18)
                .foregroundStyle(VColor.contentDisabled)
        }
    }

    // MARK: - Title

    @ViewBuilder
    private var titleStack: some View {
        if let subtitle {
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(title)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentEmphasized)
                    .lineLimit(1)
                Text(subtitle)
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
                    .lineLimit(1)
            }
        } else {
            Text(title)
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentEmphasized)
                .lineLimit(1)
        }
    }

    // MARK: - Action Buttons

    private var actionButtons: some View {
        HStack(spacing: VSpacing.xs) {
            authoriseButton
            denyButton
            dismissButton
        }
    }

    private var authoriseButton: some View {
        VButton(label: "Authorise", style: .primary, size: .pillRegular, action: onAuthorise)
    }

    private var denyButton: some View {
        VButton(label: "Deny", style: .danger, size: .pillRegular, action: onDeny)
    }

    @ViewBuilder
    private var dismissButton: some View {
        if let onDismiss {
            VButton(
                label: "Dismiss",
                iconOnly: "lucide-x",
                style: .outlined,
                size: .pillRegular,
                iconColor: VColor.primaryBase
            ) {
                onDismiss()
            }
        }
    }
}

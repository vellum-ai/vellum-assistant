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
    let showDismiss: Bool
    let onAuthorise: () -> Void
    let onDeny: () -> Void
    let onDismiss: (() -> Void)?

    init(
        title: String,
        subtitle: String? = nil,
        attachment: (fileName: String, fileSize: String)? = nil,
        showDismiss: Bool = false,
        onAuthorise: @escaping () -> Void,
        onDeny: @escaping () -> Void,
        onDismiss: (() -> Void)? = nil
    ) {
        self.title = title
        self.subtitle = subtitle
        self.attachment = attachment
        self.showDismiss = showDismiss
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
        .padding(VSpacing.sm)
        .if(isSimple) { view in
            view
                .background(Capsule().fill(VColor.auxWhite.opacity(0.1)))
                .overlay(Capsule().strokeBorder(VColor.borderElement.opacity(0.3), lineWidth: 1))
                .clipShape(Capsule())
        }
        .if(!isSimple) { view in
            view
                .background(
                    RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous)
                        .fill(VColor.auxWhite.opacity(0.1))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous)
                        .strokeBorder(VColor.borderElement.opacity(0.3), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous))
        }
        .shadow(color: VColor.auxBlack.opacity(0.05), radius: 12, x: 0, y: 4)
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
        Button {
            onAuthorise()
        } label: {
            Text("Authorise")
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentInset)
                .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
                .frame(height: 32)
                .background(Capsule().fill(VColor.primaryBase))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Authorise")
    }

    private var denyButton: some View {
        Button {
            onDeny()
        } label: {
            Text("Deny")
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentInset)
                .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
                .frame(height: 32)
                .background(Capsule().fill(VColor.systemNegativeStrong))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Deny")
    }

    private var dismissButton: some View {
        Button {
            onDismiss?()
        } label: {
            VIconView(.x, size: 12)
                .foregroundStyle(VColor.primaryBase)
                .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
                .frame(height: 32)
                .background(
                    Capsule()
                        .strokeBorder(VColor.borderElement, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dismiss")
    }
}

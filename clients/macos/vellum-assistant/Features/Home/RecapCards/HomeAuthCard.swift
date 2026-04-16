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

    var body: some View {
        HomeRecapCardView {
            VStack(spacing: VSpacing.md) {
                headerRow
                if let attachment {
                    HomeLinkFileRow(
                        icon: .file,
                        fileName: attachment.fileName,
                        fileSize: attachment.fileSize
                    )
                }
            }
        }
    }

    // MARK: - Header

    private var headerRow: some View {
        HStack(spacing: VSpacing.sm) {
            HomeRecapCardHeader(
                icon: .file,
                title: title,
                subtitle: subtitle
            )

            Spacer(minLength: 0)

            actionButtons
        }
    }

    // MARK: - Action Buttons

    private var actionButtons: some View {
        HStack(spacing: VSpacing.xs) {
            authoriseButton
            denyButton
            if showDismiss {
                dismissButton
            }
        }
    }

    private var authoriseButton: some View {
        Button {
            onAuthorise()
        } label: {
            Text("Authorise")
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.auxWhite)
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
                .foregroundStyle(VColor.auxWhite)
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
                .foregroundStyle(VColor.contentSecondary)
                .padding(VSpacing.xs)
                .background(
                    Capsule()
                        .strokeBorder(VColor.borderBase, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dismiss")
    }
}

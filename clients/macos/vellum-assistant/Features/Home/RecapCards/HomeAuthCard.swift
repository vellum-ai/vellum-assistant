import SwiftUI
import VellumAssistantShared

/// Card for payment authorisation actions. Supports two layouts:
/// - **Simple**: title + Authorise/Deny buttons in a single pill.
/// - **Rich**: title + subtitle + Authorise/Deny/Dismiss buttons in a
///   pill, with an optional file attachment pill stacked below.
///
/// Both variants render each row as an independent glassmorphic capsule
/// sitting directly on the page background, matching the Figma design.
/// Using `Material` + a subtle white tint follows Apple's recommended
/// recipe for translucent surfaces and adapts automatically between
/// light and dark mode.
/// Reference: https://developer.apple.com/documentation/swiftui/material
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

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            headerRow
                .padding(VSpacing.sm)
                .background(
                    Capsule()
                        .fill(.ultraThinMaterial)
                        .overlay(
                            Capsule().fill(VColor.auxWhite.opacity(0.1))
                        )
                )
                .clipShape(Capsule())

            if let attachment {
                HomeLinkFileRow(
                    icon: .file,
                    fileName: attachment.fileName,
                    fileSize: attachment.fileSize,
                    style: .glass
                )
            }
        }
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

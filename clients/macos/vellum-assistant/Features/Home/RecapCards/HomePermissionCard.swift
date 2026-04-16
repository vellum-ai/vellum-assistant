import SwiftUI
import VellumAssistantShared

/// Card requesting the user's permission for a tool action.
/// Displays a header with title/thread name, a content area showing
/// the tool action details with an expandable "Show Details" section,
/// and Authorise/Deny action buttons.
struct HomePermissionCard: View {
    let title: String
    let threadName: String?
    let toolActionTitle: String
    let toolActionDescription: String
    let showDismiss: Bool
    let onAuthorise: () -> Void
    let onDeny: () -> Void
    let onDismiss: (() -> Void)?

    @State private var isExpanded = false

    var body: some View {
        HomeRecapCardView(showDismiss: showDismiss, onDismiss: onDismiss) {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                HomeRecapCardHeader(
                    icon: .shieldAlert,
                    title: title,
                    subtitle: threadName,
                    showDismiss: showDismiss,
                    onDismiss: onDismiss
                )

                contentArea

                actionButtons
            }
        }
    }

    // MARK: - Content area

    /// Tool action content with distinct background, divider, and
    /// expandable details toggle.
    private var contentArea: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text(toolActionTitle)
                .font(VFont.menuCompact)
                .foregroundStyle(VColor.contentSecondary)
                .lineLimit(nil)

            showDetailsRow

            if isExpanded {
                Divider()

                Text(toolActionDescription)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(nil)
            }
        }
        .padding(VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg, style: .continuous)
                .fill(VColor.surfaceOverlay)
        )
        .animation(.easeInOut(duration: 0.2), value: isExpanded)
    }

    // MARK: - Show Details toggle

    /// Tappable row with "Show Details" text and a chevron icon.
    private var showDetailsRow: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                isExpanded.toggle()
            }
        } label: {
            HStack(spacing: VSpacing.xs) {
                Text("Show Details")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDefault)

                VIconView(isExpanded ? .chevronDown : .chevronRight, size: 10)
                    .foregroundStyle(VColor.contentDefault)
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: - Action buttons

    /// Authorise and Deny bordered pill buttons.
    private var actionButtons: some View {
        HStack(spacing: VSpacing.sm) {
            Button {
                onAuthorise()
            } label: {
                Text("Authorise")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.buttonV)
                    .background(
                        Capsule()
                            .strokeBorder(VColor.borderBase, lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)

            Button {
                onDeny()
            } label: {
                Text("Deny")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.buttonV)
                    .background(
                        Capsule()
                            .strokeBorder(VColor.borderBase, lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)
        }
    }
}

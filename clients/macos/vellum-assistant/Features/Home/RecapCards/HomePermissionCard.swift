import SwiftUI
import VellumAssistantShared

/// Card requesting the user's permission for a tool action.
/// Header shows icon + title + thread name + X dismiss. An optional
/// inner content area displays the tool action details with an
/// expandable "Show Details" toggle. Allow Once / Deny action buttons
/// match the styling pattern used in HomeAuthCard.
struct HomePermissionCard: View {
    let title: String
    let threadName: String?
    let toolActionTitle: String?
    let toolActionDescription: String?
    let onAuthorise: () -> Void
    let onDeny: () -> Void
    let onDismiss: (() -> Void)?

    @State private var isExpanded = false

    init(
        title: String,
        threadName: String? = nil,
        toolActionTitle: String? = nil,
        toolActionDescription: String? = nil,
        onAuthorise: @escaping () -> Void,
        onDeny: @escaping () -> Void,
        onDismiss: (() -> Void)? = nil
    ) {
        self.title = title
        self.threadName = threadName
        self.toolActionTitle = toolActionTitle
        self.toolActionDescription = toolActionDescription
        self.onAuthorise = onAuthorise
        self.onDeny = onDeny
        self.onDismiss = onDismiss
    }

    private var hasContent: Bool {
        toolActionTitle != nil || toolActionDescription != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            headerRow
            if hasContent {
                contentArea
            }
            actionButtons
        }
        .glassCard()
        .recapCardMaxWidth()
    }

    // MARK: - Header

    private var headerRow: some View {
        HStack(spacing: VSpacing.sm) {
            iconCircle
            titleStack
            Spacer(minLength: 0)
            dismissButton
        }
    }

    private var iconCircle: some View {
        ZStack {
            Circle()
                .fill(VColor.surfaceLift)
                .frame(width: 38, height: 38)
            VIconView(.lockOpen, size: 18)
                .foregroundStyle(VColor.contentDisabled)
        }
    }

    @ViewBuilder
    private var titleStack: some View {
        if let threadName {
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(title)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentEmphasized)
                    .multilineTextAlignment(.leading)
                Text(threadName)
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
                    .lineLimit(1)
            }
        } else {
            Text(title)
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentEmphasized)
                .multilineTextAlignment(.leading)
        }
    }

    // MARK: - Content area

    /// Tool action content with FDFDFC overlay background, full width.
    /// Shows tool action title + divider + description + Show Details toggle.
    private var contentArea: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            if let toolActionTitle {
                Text(toolActionTitle)
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(nil)
                    .padding(.horizontal, VSpacing.xs)

                Rectangle()
                    .fill(VColor.surfaceBase)
                    .frame(height: 1)
            }

            if let toolActionDescription {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text(toolActionDescription)
                        .font(VFont.bodyMediumEmphasised)
                        .foregroundStyle(VColor.contentDefault)
                        .lineLimit(nil)
                        .multilineTextAlignment(.leading)

                    showDetailsRow

                    if isExpanded {
                        expandedDetailsStub
                    }
                }
                .padding(VSpacing.xs)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, VSpacing.sm)
        .padding(.top, VSpacing.sm)
        .padding(.bottom, 6)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(VColor.surfaceOverlay)
        )
    }

    // MARK: - Show Details toggle

    private var showDetailsRow: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                isExpanded.toggle()
            }
        } label: {
            HStack(spacing: VSpacing.xs) {
                Text("Show Details")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)

                VIconView(isExpanded ? .chevronUp : .chevronDown, size: 10)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isExpanded ? "Hide details" : "Show details")
    }

    /// Placeholder content shown when the "Show Details" toggle is
    /// expanded. Intentionally a stub until the permission-request
    /// payload wiring lands — when it does, replace this with the
    /// tool arguments / raw request body from the caller.
    private var expandedDetailsStub: some View {
        Text("Additional tool details will appear here once wired to the permission request payload.")
            .font(VFont.labelDefault)
            .foregroundStyle(VColor.contentTertiary)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Action buttons

    /// Allow Once + Deny pill buttons matching HomeAuthCard styling.
    private var actionButtons: some View {
        HStack(spacing: VSpacing.xs) {
            allowOnceButton
            denyButton
        }
    }

    private var allowOnceButton: some View {
        VButton(label: "Allow Once", style: .primary, size: .pillRegular, action: onAuthorise)
    }

    private var denyButton: some View {
        VButton(label: "Deny", style: .danger, size: .pillRegular, action: onDeny)
    }

    private var dismissButton: some View {
        VButton(
            label: "Dismiss",
            iconOnly: "lucide-x",
            style: .outlined,
            size: .pillRegular,
            iconColor: VColor.primaryBase
        ) {
            onDismiss?()
        }
    }
}

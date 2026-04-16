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
        .padding(VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous)
                .fill(glassFill)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous)
                .strokeBorder(glassStroke, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous))
        .shadow(color: VColor.auxBlack.opacity(0.08), radius: 16, x: 0, y: 6)
    }

    // MARK: - Glass Recipe

    /// Synthetic glassmorphism — adaptive across light/dark, context-independent.
    /// Matches HomeAuthCard recipe for visual consistency across recap cards.
    private var glassFill: LinearGradient {
        LinearGradient(
            colors: [
                VColor.contentEmphasized.opacity(0.06),
                VColor.contentEmphasized.opacity(0.02),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    private var glassStroke: LinearGradient {
        LinearGradient(
            colors: [
                VColor.contentEmphasized.opacity(0.18),
                VColor.contentEmphasized.opacity(0.06),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
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
        Button {
            onAuthorise()
        } label: {
            Text("Allow Once")
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentInset)
                .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
                .frame(height: 32)
                .background(Capsule().fill(VColor.primaryBase))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Allow Once")
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

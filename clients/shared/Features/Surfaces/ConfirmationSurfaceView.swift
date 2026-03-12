import SwiftUI

public struct ConfirmationSurfaceView: View {
    public let data: ConfirmationSurfaceData
    public let actions: [SurfaceActionButton]
    public let showCardChrome: Bool
    public let onAction: (String) -> Void

    private enum SelectedAction {
        case confirmed
        case cancelled
    }

    @State private var selectedAction: SelectedAction?

    public init(data: ConfirmationSurfaceData, actions: [SurfaceActionButton], showCardChrome: Bool = false, onAction: @escaping (String) -> Void) {
        self.data = data
        self.actions = actions
        self.showCardChrome = showCardChrome
        self.onAction = onAction
    }

    /// The action ID to emit when the user cancels.
    /// Uses the first server-provided action ID if exactly 2 actions are defined, otherwise defaults to "cancel".
    private var cancelActionId: String {
        if actions.count == 2 {
            return actions[0].id
        }
        return "cancel"
    }

    /// The action ID to emit when the user confirms.
    /// Uses the second server-provided action ID if exactly 2 actions are defined, otherwise defaults to "confirm".
    private var confirmActionId: String {
        if actions.count == 2 {
            return actions[1].id
        }
        return "confirm"
    }

    public var body: some View {
        Group {
            if let selectedAction {
                selectedActionFeedback(selectedAction)
            } else if showCardChrome {
                pendingContent
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .inlineWidgetCard()
            } else {
                pendingContent
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .onChange(of: data) { _, _ in
            selectedAction = nil
        }
    }

    /// Parse inline markdown (bold, italic, code) into an AttributedString.
    private func inlineMarkdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: text, options: options))
            ?? AttributedString(text)
    }

    private var pendingContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Header with icon
            HStack(alignment: .top, spacing: VSpacing.md) {
                VIconView(.triangleAlert, size: 24)
                    .foregroundStyle(data.destructive ? VColor.systemNegativeStrong : VColor.systemNegativeHover)
                Text(inlineMarkdown(data.message))
                    .font(VFont.headline)
                    .foregroundColor(VColor.contentDefault)
            }

            // Detail text
            if let detail = data.detail {
                Text(inlineMarkdown(detail))
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
            }

            // Action buttons
            HStack(spacing: VSpacing.lg) {
                Spacer()

                VButton(
                    label: data.cancelLabel ?? "Cancel",
                    style: .tertiary
                ) {
                    selectedAction = .cancelled
                    onAction(cancelActionId)
                }

                VButton(
                    label: data.confirmLabel ?? "Confirm",
                    style: data.destructive ? .danger : .primary
                ) {
                    selectedAction = .confirmed
                    onAction(confirmActionId)
                }
            }
        }
    }

    @ViewBuilder
    private func selectedActionFeedback(_ action: SelectedAction) -> some View {
        HStack(spacing: VSpacing.sm) {
            switch action {
            case .confirmed:
                VIconView(.circleCheck, size: 12)
                    .foregroundColor(VColor.systemPositiveStrong)
                Text(data.confirmedLabel ?? "Done")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.contentDefault)
            case .cancelled:
                VIconView(.circleX, size: 12)
                    .foregroundColor(VColor.contentTertiary)
                Text(data.cancelLabel ?? "Dismissed")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.contentSecondary)
            }
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceBase.opacity(0.5))
        )
    }
}

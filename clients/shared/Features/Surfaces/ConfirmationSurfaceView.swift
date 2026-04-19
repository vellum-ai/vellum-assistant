import SwiftUI

public struct ConfirmationSurfaceView: View {
    public let data: ConfirmationSurfaceData
    public let showCardChrome: Bool
    public let onAction: (String) -> Void

    private enum SelectedAction {
        case confirmed
        case cancelled
    }

    @State private var selectedAction: SelectedAction?

    /// The action ID to emit when the user confirms.
    /// Defaults to "confirm"; overridden when explicit actions are provided.
    private let confirmActionId: String

    /// The action ID to emit when the user cancels/denies.
    /// Defaults to "cancel"; overridden when explicit actions are provided.
    private let cancelActionId: String

    public init(
        data: ConfirmationSurfaceData,
        showCardChrome: Bool = false,
        confirmActionId: String = "confirm",
        cancelActionId: String = "cancel",
        onAction: @escaping (String) -> Void
    ) {
        self.data = data
        self.showCardChrome = showCardChrome
        self.confirmActionId = confirmActionId
        self.cancelActionId = cancelActionId
        self.onAction = onAction
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
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Header with icon
            HStack(alignment: .center, spacing: VSpacing.md) {
                VIconView(.triangleAlert, size: 24)
                    .foregroundStyle(data.destructive ? VColor.systemNegativeStrong : VColor.systemMidStrong)
                Text(inlineMarkdown(data.message))
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentDefault)
            }

            // Detail text
            if let detail = data.detail {
                Text(inlineMarkdown(detail))
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
            }

            // Action buttons
            HStack(spacing: VSpacing.sm) {
                Spacer()

                VButton(
                    label: data.cancelLabel ?? "Cancel",
                    style: .outlined
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
                    .foregroundStyle(VColor.systemPositiveStrong)
                Text(data.confirmedLabel ?? "Done")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDefault)
            case .cancelled:
                VIconView(.circleX, size: 12)
                    .foregroundStyle(VColor.contentTertiary)
                Text(data.cancelLabel ?? "Dismissed")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceOverlay.opacity(0.5))
        )
    }
}

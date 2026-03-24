import VellumAssistantShared
import SwiftUI

struct SurfaceContainerView: View {
    var viewModel: SurfaceViewModel

    private var surface: Surface { viewModel.surface }

    private var isDynamicPage: Bool {
        if case .dynamicPage = surface.data { return true }
        return false
    }

    var body: some View {
        Group {
            if case .dynamicPage = surface.data {
                innerContent
            } else if case .list = surface.data {
                innerContent
            } else {
                ScrollView(.vertical) {
                    innerContent
                }
            }
        }
        .frame(minWidth: 280, maxWidth: .infinity)
        .modifier(ConditionalPanelBackground(apply: !isDynamicPage))
    }

    @ViewBuilder
    private var innerContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if !isDynamicPage {
                // Title row with dismiss button
                HStack(alignment: .top) {
                    if let title = surface.title {
                        Text(title)
                            .font(VFont.bodySmallEmphasised)
                            .foregroundColor(VColor.contentDefault)
                    }
                    Spacer()
                    Button(action: { viewModel.onDismiss() }) {
                        VIconView(.x, size: 10)
                            .foregroundColor(VColor.contentSecondary)
                    }
                    .buttonStyle(.plain)
                }
            }

            // Type-specific content
            switch surface.data {
            case .card(let data):
                CardSurfaceView(data: data)
            case .form(let data):
                FormSurfaceView(data: data, onSubmit: { values in
                    let actionId = surface.actions.first?.id ?? "submit"
                    viewModel.onAction(actionId, values)
                })
                .id(surface.id)
            case .list(let data):
                ListSurfaceView(data: data, onSelect: { selectedIds in
                    viewModel.onAction("select", ["selectedIds": selectedIds])
                })
            case .confirmation(let data):
                ConfirmationSurfaceView(
                    data: data,
                    actions: surface.actions,
                    onAction: { actionId in
                        viewModel.onAction(actionId, nil)
                    }
                )
            case .dynamicPage(let data):
                DynamicPageSurfaceView(
                    data: data,
                    onAction: { actionId, actionData in
                        viewModel.onAction(actionId, actionData as? [String: Any])
                    },
                    appId: viewModel.appId,
                    onDataRequest: viewModel.onDataRequest,
                    onCoordinatorReady: viewModel.onCoordinatorReady,
                    onLinkOpen: viewModel.onLinkOpen,
                    sandboxMode: viewModel.sandboxMode
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .fileUpload(let data):
                FileUploadSurfaceView(
                    data: data,
                    onSubmit: { files in
                        let actionId = surface.actions.first?.id ?? "submit"
                        viewModel.onAction(actionId, ["files": files])
                    },
                    onCancel: {
                        viewModel.onAction("cancel", ["files": [Any]()])
                        viewModel.onDismiss()
                    }
                )
            case .table, .documentPreview:
                // These surfaces are rendered inline in chat, not in floating panels.
                EmptyView()
            case .stripped, .strippedFailed:
                EmptyView()
            }

            // Action buttons for card/list surfaces
            if !surface.actions.isEmpty && !isFormOrConfirmation {
                actionButtons
            }
        }
        .padding(isDynamicPage ? 0 : VSpacing.xl)
    }

    // MARK: - Helpers

    private var isFormOrConfirmation: Bool {
        switch surface.data {
        case .form, .confirmation, .dynamicPage, .fileUpload:
            return true
        case .card, .list, .table, .documentPreview, .stripped, .strippedFailed:
            return false
        }
    }

    private var actionButtons: some View {
        HStack(spacing: VSpacing.md) {
            Spacer()
            ForEach(surface.actions, id: \.uniqueId) { action in
                VButton(
                    label: action.label,
                    style: buttonStyle(for: action.style)
                ) {
                    viewModel.onAction(action.id, action.data?.compactMapValues { $0.value })
                }
            }
        }
    }

    private func buttonStyle(for style: SurfaceActionStyle) -> VButton.Style {
        switch style {
        case .primary: return .primary
        case .secondary: return .outlined
        case .destructive: return .danger
        }
    }
}

private struct ConditionalPanelBackground: ViewModifier {
    let apply: Bool

    func body(content: Content) -> some View {
        if apply {
            content.vPanelBackground()
        } else {
            content
        }
    }
}

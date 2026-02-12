import SwiftUI

struct SurfaceContainerView: View {
    @ObservedObject var viewModel: SurfaceViewModel

    private var surface: Surface { viewModel.surface }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Title row with dismiss button
            HStack(alignment: .top) {
                if let title = surface.title {
                    Text(title)
                        .font(VFont.headline)
                        .foregroundColor(VColor.textPrimary)
                }
                Spacer()
                Button(action: { viewModel.onDismiss() }) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(VColor.textSecondary)
                }
                .buttonStyle(.plain)
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
                DynamicPageSurfaceView(data: data, onAction: { actionId, actionData in
                    viewModel.onAction(actionId, actionData as? [String: Any])
                })
                .frame(
                    width: CGFloat(data.width ?? 380),
                    height: CGFloat(data.height ?? 500)
                )
            }

            // Action buttons for card/list surfaces
            if !surface.actions.isEmpty && !isFormOrConfirmation {
                actionButtons
            }
        }
        .padding(VSpacing.xl)
        .frame(width: surfaceWidth)
        .vPanelBackground()
    }

    // MARK: - Helpers

    private var surfaceWidth: CGFloat {
        if case .dynamicPage(let data) = surface.data {
            return CGFloat(data.width ?? 380)
        }
        return 380
    }

    private var isFormOrConfirmation: Bool {
        switch surface.data {
        case .form, .confirmation, .dynamicPage:
            return true
        case .card, .list:
            return false
        }
    }

    private var actionButtons: some View {
        HStack(spacing: VSpacing.md) {
            Spacer()
            ForEach(surface.actions) { action in
                VButton(
                    label: action.label,
                    style: buttonStyle(for: action.style)
                ) {
                    viewModel.onAction(action.id, nil)
                }
            }
        }
    }

    private func buttonStyle(for style: SurfaceActionStyle) -> VButton.Style {
        switch style {
        case .primary: return .primary
        case .secondary: return .ghost
        case .destructive: return .danger
        }
    }
}

#Preview {
    SurfaceContainerView(
        viewModel: SurfaceViewModel(
            surface: Surface(
                id: "preview",
                sessionId: "session-1",
                type: .card,
                title: "Task Summary",
                data: .card(CardSurfaceData(
                    title: "Screenshot Captured",
                    subtitle: "Step 2 of 5",
                    body: "Captured the current screen state for analysis.",
                    metadata: nil
                )),
                actions: [
                    SurfaceActionButton(id: "dismiss", label: "Dismiss", style: .secondary),
                    SurfaceActionButton(id: "continue", label: "Continue", style: .primary),
                ]
            ),
            onAction: { _, _ in }
        )
    )
}

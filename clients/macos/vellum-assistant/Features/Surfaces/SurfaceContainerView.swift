import SwiftUI

struct SurfaceContainerView: View {
    let surface: Surface
    let onAction: (String, [String: Any]?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Optional title
            if let title = surface.title {
                Text(title)
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)
            }

            // Type-specific content
            switch surface.data {
            case .card(let data):
                CardSurfaceView(data: data)
            case .form(let data):
                FormSurfaceView(data: data, onSubmit: { values in
                    onAction("submit", values)
                })
            case .list(let data):
                ListSurfaceView(data: data, onSelect: { selectedIds in
                    onAction("select", ["selectedIds": selectedIds])
                })
            case .confirmation(let data):
                ConfirmationSurfaceView(data: data, onAction: { actionId in
                    onAction(actionId, nil)
                })
            }

            // Action buttons for card/list surfaces
            if !surface.actions.isEmpty && !isFormOrConfirmation {
                actionButtons
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 380)
        .vPanelBackground()
    }

    // MARK: - Helpers

    private var isFormOrConfirmation: Bool {
        switch surface.data {
        case .form, .confirmation:
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
                    onAction(action.id, nil)
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

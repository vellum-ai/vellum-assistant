import SwiftUI

/// Routes an `InlineSurfaceData` to the correct inline widget view.
struct InlineSurfaceRouter: View {
    let surface: InlineSurfaceData
    let onAction: (String, String, [String: AnyCodable]?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            if let title = surface.title {
                Text(title)
                    .font(VFont.cardTitle)
                    .foregroundColor(VColor.textPrimary)
            }

            surfaceContent

            if !surface.actions.isEmpty {
                actionButtons
            }
        }
        .padding(VSpacing.lg)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder.opacity(0.4), lineWidth: 1)
        )
        .vShadow(VShadow.sm)
    }

    @ViewBuilder
    private var surfaceContent: some View {
        switch surface.data {
        case .card(let data):
            InlineCardWidget(data: data)
        case .table(let data):
            InlineTableWidget(data: data) { actionId, payload in
                onAction(surface.id, actionId, payload)
            }
        case .list(let data):
            InlineListWidget(data: data)
        default:
            InlineFallbackChip(surfaceType: surface.surfaceType)
        }
    }

    private var actionButtons: some View {
        HStack(spacing: VSpacing.sm) {
            Spacer()
            ForEach(surface.actions) { action in
                Button {
                    onAction(surface.id, action.id, nil)
                } label: {
                    Text(action.label)
                        .font(VFont.bodyMedium)
                        .foregroundColor(buttonForeground(action.style))
                        .padding(.horizontal, VSpacing.lg)
                        .padding(.vertical, VSpacing.sm)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .fill(buttonBackground(action.style))
                        )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func buttonForeground(_ style: SurfaceActionStyle) -> Color {
        switch style {
        case .primary: return .white
        case .destructive: return .white
        case .secondary: return VColor.textPrimary
        }
    }

    private func buttonBackground(_ style: SurfaceActionStyle) -> Color {
        switch style {
        case .primary: return VColor.accent
        case .destructive: return VColor.error
        case .secondary: return VColor.surfaceBorder.opacity(0.5)
        }
    }
}

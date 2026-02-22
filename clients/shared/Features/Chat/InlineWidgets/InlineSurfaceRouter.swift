import SwiftUI

/// Routes an `InlineSurfaceData` to the correct inline widget view.
public struct InlineSurfaceRouter: View {
    public let surface: InlineSurfaceData
    public let onAction: (String, String, [String: AnyCodable]?) -> Void

    @State private var selectionPayload: [String: AnyCodable]?

    public init(surface: InlineSurfaceData, onAction: @escaping (String, String, [String: AnyCodable]?) -> Void) {
        self.surface = surface
        self.onAction = onAction
    }

    /// Whether the surface content handles its own header/chrome.
    private var isTemplateCard: Bool {
        if case .card(let data) = surface.data, data.template != nil {
            return true
        }
        return false
    }

    /// Dynamic page previews render as compact cards that wrap their content.
    private var isDynamicPreview: Bool {
        if case .dynamicPage(let data) = surface.data, data.preview != nil {
            return true
        }
        return false
    }

    private var isDocumentPreview: Bool {
        if case .documentPreview = surface.data { return true }
        return false
    }

    public var body: some View {
        if let completion = surface.completionState {
            CompletedSurfaceChip(title: surface.title, summary: completion.summary)
        } else {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Template cards and dynamic page previews handle their own header
            if !isTemplateCard, !isDynamicPreview, !isDocumentPreview, let title = surface.title {
                Text(title)
                    .font(VFont.cardTitle)
                    .foregroundColor(VColor.textPrimary)
            }

            surfaceContent

            if !surface.actions.isEmpty {
                actionButtons
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .inlineWidgetCard(interactive: isDynamicPreview || isDocumentPreview)
        .overlay(alignment: .topTrailing) {
            if isDynamicPreview {
                Button {
                    if let msg = surface.surfaceMessage {
                        NotificationCenter.default.post(
                            name: Notification.Name("MainWindow.openDynamicWorkspace"),
                            object: nil,
                            userInfo: ["surfaceMessage": msg]
                        )
                    }
                } label: {
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(VColor.textSecondary)
                        .padding(VSpacing.xs)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.sm)
                                .fill(VColor.surfaceBorder.opacity(0.3))
                        )
                }
                .buttonStyle(.plain)
                .padding(VSpacing.sm)
            } else if isDocumentPreview {
                if case .documentPreview(let data) = surface.data {
                    Button {
                        NotificationCenter.default.post(
                            name: Notification.Name("MainWindow.openDocumentEditor"),
                            object: nil,
                            userInfo: ["documentSurfaceId": data.surfaceId]
                        )
                    } label: {
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(VColor.textSecondary)
                            .padding(VSpacing.xs)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.sm)
                                    .fill(VColor.surfaceBorder.opacity(0.3))
                            )
                    }
                    .buttonStyle(.plain)
                    .padding(VSpacing.sm)
                }
            }
        }
        // Consistent width for all widget cards; dynamic page previews and document previews are more compact.
        .frame(maxWidth: isDynamicPreview || isDocumentPreview ? 350 : 540, alignment: .leading)
        }
    }

    @ViewBuilder
    private var surfaceContent: some View {
        switch surface.data {
        case .card(let data):
            InlineCardWidget(data: data)
        case .documentPreview(let data):
            InlineDocumentPreview(data: data) {
                NotificationCenter.default.post(
                    name: Notification.Name("MainWindow.openDocumentEditor"),
                    object: nil,
                    userInfo: ["documentSurfaceId": data.surfaceId]
                )
            }
        case .dynamicPage(let data):
            if let preview = data.preview {
                InlineDynamicPagePreview(preview: preview) {
                    // Post notification to open (or re-open) the workspace
                    if let msg = surface.surfaceMessage {
                        NotificationCenter.default.post(
                            name: Notification.Name("MainWindow.openDynamicWorkspace"),
                            object: nil,
                            userInfo: ["surfaceMessage": msg]
                        )
                    }
                }
            } else {
                // Still allow opening the workspace even without a preview card.
                Button {
                    if let msg = surface.surfaceMessage {
                        NotificationCenter.default.post(
                            name: Notification.Name("MainWindow.openDynamicWorkspace"),
                            object: nil,
                            userInfo: ["surfaceMessage": msg]
                        )
                    }
                } label: {
                    InlineFallbackChip(surfaceType: surface.surfaceType)
                }
                .buttonStyle(.plain)
            }
        case .table(let data):
            InlineTableWidget(data: data) { actionId, payload in
                if actionId == "selection_changed" {
                    selectionPayload = payload
                    return
                }
                onAction(surface.id, actionId, payload)
            }
        case .list(let data):
            InlineListWidget(data: data) { actionId, payload in
                if actionId == "selection_changed" {
                    selectionPayload = payload
                    return
                }
                onAction(surface.id, actionId, payload)
            }
        case .form(let data):
            FormSurfaceView(data: data) { values in
                var payload: [String: AnyCodable]? = nil
                if let values {
                    payload = values.mapValues { AnyCodable($0) }
                }
                onAction(surface.id, "submit", payload)
            }
            .id(surface.id)
        case .confirmation(let data):
            ConfirmationSurfaceView(data: data, actions: surface.actions) { actionId in
                onAction(surface.id, actionId, nil)
            }
        default:
            InlineFallbackChip(surfaceType: surface.surfaceType)
        }
    }

    private var actionButtons: some View {
        HStack(spacing: VSpacing.sm) {
            Spacer()
            ForEach(surface.actions) { action in
                Button {
                    onAction(surface.id, action.id, selectionPayload)
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

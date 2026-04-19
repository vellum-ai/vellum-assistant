import os
import SwiftUI

private let log = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "InlineSurfaceRouter"
)

/// Routes an `InlineSurfaceData` to the correct inline widget view.
public struct InlineSurfaceRouter: View {
    public let surface: InlineSurfaceData
    public let onAction: (String, String, [String: AnyCodable]?) -> Void
    /// Called when a `.stripped` surface appears and needs its data re-fetched.
    public let onRefetch: ((String, String) -> Void)?

    @State private var selectionPayload: [String: AnyCodable]?
    @State private var clickedActionLabel: String?
    @State private var isCardHovered = false

    public init(
        surface: InlineSurfaceData,
        onAction: @escaping (String, String, [String: AnyCodable]?) -> Void,
        onRefetch: ((String, String) -> Void)? = nil
    ) {
        self.surface = surface
        self.onAction = onAction
        self.onRefetch = onRefetch
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

    private var isAppCreated: Bool {
        #if os(macOS)
        if case .dynamicPage(let data) = surface.data,
           let preview = data.preview, preview.context == "app_create" || data.appId != nil { return true }
        #endif
        return false
    }

    private var isDocumentPreview: Bool {
        if case .documentPreview = surface.data { return true }
        return false
    }

    private var isTableSurface: Bool {
        if case .table = surface.data { return true }
        return false
    }

    private var standardWidgetMaxWidth: CGFloat {
        // Tables should use the full chat bubble width before falling back to horizontal scroll.
        isTableSurface ? VSpacing.chatBubbleMaxWidth : 540
    }

    /// Whether the surface renders as a lightweight chip without card chrome.
    private var isChipOnlySurface: Bool {
        return false
    }

    public var body: some View {
        Group {
        if case .strippedFailed = surface.data {
            strippedFailedPlaceholder
        } else if case .stripped = surface.data {
            strippedPlaceholder
        } else if let completion = surface.completionState {
            CompletedSurfaceChip(title: surface.title, summary: completion.summary)
        } else if case .confirmation(let data) = surface.data {
            // Confirmations manage their own card chrome — collapse to a chip after user acts
            let confirmId = surface.actions.first(where: { $0.style == .primary })?.id ?? "confirm"
            let cancelId = surface.actions.first(where: { $0.style != .primary })?.id ?? "cancel"
            ConfirmationSurfaceView(
                data: data,
                showCardChrome: true,
                confirmActionId: confirmId,
                cancelActionId: cancelId
            ) { actionId in
                onAction(surface.id, actionId, nil)
            }
            .widthCap(540)
        } else if isChipOnlySurface || isAppCreated {
            surfaceContent
                .widthCap(isAppCreated ? 400 : nil)
        } else {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Template cards and dynamic page previews handle their own header
            if !isTemplateCard, !isDynamicPreview, !isDocumentPreview, let title = surface.title {
                Text(title)
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
            }

            surfaceContent

            if !surface.actions.isEmpty {
                actionButtons
            }
        }
        .inlineWidgetCard(interactive: isDynamicPreview || isDocumentPreview)
        .overlay(alignment: .topTrailing) {
            if isDynamicPreview && !isAppCreated {
                Button {
                    if let ref = surface.surfaceRef {
                        NotificationCenter.default.post(
                            name: Notification.Name("MainWindow.openDynamicWorkspace"),
                            object: nil,
                            userInfo: ["surfaceRef": ref]
                        )
                    }
                } label: {
                    VIconView(.arrowUpRight, size: 10)
                        .foregroundStyle(VColor.contentSecondary)
                        .padding(VSpacing.xs)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.sm)
                                .fill(VColor.borderBase.opacity(0.3))
                        )
                }
                .buttonStyle(.plain)
                .padding(VSpacing.sm)
            } else if isTableSurface, case .table(let tableData) = surface.data {
                #if os(macOS)
                VCopyButton(text: Self.tableAsMarkdown(tableData), size: .compact)
                    .opacity(isCardHovered ? 1 : 0)
                    .animation(VAnimation.fast, value: isCardHovered)
                    .padding(VSpacing.sm)
                #endif
            } else if isDocumentPreview {
                if case .documentPreview(let data) = surface.data {
                    Button {
                        NotificationCenter.default.post(
                            name: Notification.Name("MainWindow.openDocumentEditor"),
                            object: nil,
                            userInfo: ["documentSurfaceId": data.surfaceId]
                        )
                    } label: {
                        VIconView(.arrowUpRight, size: 10)
                            .foregroundStyle(VColor.contentSecondary)
                            .padding(VSpacing.xs)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.sm)
                                    .fill(VColor.borderBase.opacity(0.3))
                            )
                    }
                    .buttonStyle(.plain)
                    .padding(VSpacing.sm)
                }
            }
        }
        #if os(macOS)
        .onHover { isCardHovered = $0 }
        #endif
        // Dynamic page/document previews stay compact; tables can grow to the chat bubble max width.
        .widthCap(isAppCreated ? 400 : (isDynamicPreview || isDocumentPreview ? 350 : standardWidgetMaxWidth))
        }
        }
        .onChange(of: surface) { oldSurface, newSurface in
            if newSurface.completionState != nil { return }
            // Reset clicked state when content/actions change, or when completion is cleared
            // (transition from completed back to active) so buttons become actionable again.
            if oldSurface.data != newSurface.data || oldSurface.actions != newSurface.actions || oldSurface.completionState != nil {
                clickedActionLabel = nil
            }
        }
    }

    /// Placeholder shown while a stripped surface's data is being re-fetched.
    @ViewBuilder
    private var strippedPlaceholder: some View {
        HStack(spacing: VSpacing.sm) {
            VLoadingIndicator(size: 14, color: VColor.contentSecondary)
            Text(surface.title ?? "Loading surface…")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
        }
        .padding(VSpacing.md)
        .widthCap(540)
        .inlineWidgetCard(interactive: false)
        .onAppear {
            guard let conversationId = surface.surfaceRef?.conversationId else {
                log.warning("Surface \(surface.id) has no surfaceRef — cannot refetch")
                return
            }
            onRefetch?(surface.id, conversationId)
        }
    }

    /// Placeholder shown when a stripped surface could not be re-fetched after retries.
    @ViewBuilder
    private var strippedFailedPlaceholder: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.triangleAlert, size: 12)
                .foregroundStyle(VColor.contentSecondary)
            Text("Failed to load surface")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
        }
        .padding(VSpacing.md)
        .widthCap(540)
        .inlineWidgetCard(interactive: false)
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
                #if os(macOS)
                if preview.context == "app_create" || data.appId != nil {
                    InlineAppCreatedCard(
                        preview: preview,
                        appId: data.appId,
                        html: data.html,
                        isToolCallComplete: surface.isToolCallComplete,
                        onOpenApp: {
                            if let ref = surface.surfaceRef {
                                NotificationCenter.default.post(
                                    name: Notification.Name("MainWindow.openDynamicWorkspace"),
                                    object: nil,
                                    userInfo: ["surfaceRef": ref]
                                )
                            }
                        },
                        onTogglePin: data.appId.map { appId in
                            { isPinned in
                                NotificationCenter.default.post(
                                    name: Notification.Name(isPinned ? "MainWindow.unpinApp" : "MainWindow.pinApp"),
                                    object: nil,
                                    userInfo: [
                                        "appId": appId,
                                        "appName": preview.title,
                                        "appIcon": preview.icon as Any
                                    ]
                                )
                            }
                        }
                    )
                } else {
                    InlineDynamicPagePreview(preview: preview) {
                        if let ref = surface.surfaceRef {
                            NotificationCenter.default.post(
                                name: Notification.Name("MainWindow.openDynamicWorkspace"),
                                object: nil,
                                userInfo: ["surfaceRef": ref]
                            )
                        }
                    }
                }
                #else
                InlineDynamicPagePreview(preview: preview) {
                    // Post notification to open (or re-open) the workspace
                    if let ref = surface.surfaceRef {
                        NotificationCenter.default.post(
                            name: Notification.Name("MainWindow.openDynamicWorkspace"),
                            object: nil,
                            userInfo: ["surfaceRef": ref]
                        )
                    }
                }
                #endif
            } else {
                // Still allow opening the workspace even without a preview card.
                Button {
                    if let ref = surface.surfaceRef {
                        NotificationCenter.default.post(
                            name: Notification.Name("MainWindow.openDynamicWorkspace"),
                            object: nil,
                            userInfo: ["surfaceRef": ref]
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
            let confirmId = surface.actions.first(where: { $0.style == .primary })?.id ?? "confirm"
            let cancelId = surface.actions.first(where: { $0.style != .primary })?.id ?? "cancel"
            ConfirmationSurfaceView(
                data: data,
                confirmActionId: confirmId,
                cancelActionId: cancelId
            ) { actionId in
                onAction(surface.id, actionId, nil)
            }
        #if os(macOS)
        case .fileUpload(let data):
            FileUploadSurfaceView(
                data: data,
                onSubmit: { files in
                    let payload: [String: AnyCodable] = ["files": AnyCodable(files)]
                    onAction(surface.id, "submit", payload)
                },
                onCancel: {
                    onAction(surface.id, "cancel", nil)
                }
            )
        #endif
        default:
            InlineFallbackChip(surfaceType: surface.surfaceType)
        }
    }

    @ViewBuilder
    private var actionButtons: some View {
        if let label = clickedActionLabel {
            HStack(spacing: VSpacing.sm) {
                Spacer()
                HStack(spacing: VSpacing.sm) {
                    VIconView(.circleCheck, size: 12)
                        .foregroundStyle(VColor.systemPositiveStrong)
                    Text(label)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentDefault)
                }
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(VColor.surfaceOverlay.opacity(0.5))
                )
            }
        } else {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(surface.actions, id: \.uniqueId) { action in
                    VButton(
                        label: action.label,
                        style: buttonStyle(for: action.style)
                    ) {
                        clickedActionLabel = action.label
                        var merged = selectionPayload ?? [:]
                        if let actionData = action.data {
                            for (key, value) in actionData {
                                merged[key] = value
                            }
                        }
                        onAction(surface.id, action.id, merged.isEmpty ? nil : merged)
                    }
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

    /// Builds a markdown table string from TableSurfaceData for clipboard copy.
    static func tableAsMarkdown(_ data: TableSurfaceData) -> String {
        func escapeCell(_ text: String) -> String {
            text.replacingOccurrences(of: "|", with: "\\|")
                .replacingOccurrences(of: "\n", with: " ")
        }
        let headers = data.columns.map { escapeCell($0.label) }
        let headerLine = "| " + headers.joined(separator: " | ") + " |"
        let separatorLine = "| " + headers.map { _ in "---" }.joined(separator: " | ") + " |"
        let rowLines = data.rows.map { row in
            "| " + data.columns.map { col in
                escapeCell(row.cells[col.id]?.text ?? "")
            }.joined(separator: " | ") + " |"
        }
        return ([headerLine, separatorLine] + rowLines).joined(separator: "\n")
    }
}

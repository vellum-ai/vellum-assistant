import Foundation

// MARK: - Surface Enums

public enum SurfaceType: String, Codable, Sendable {
    case card
    case form
    case list
    case table
    case confirmation
    case dynamicPage = "dynamic_page"
    case fileUpload = "file_upload"
    case documentPreview = "document_preview"
}

public enum SurfaceActionStyle: String, Codable, Sendable {
    case primary
    case secondary
    case destructive
}

public enum SelectionMode: String, Sendable, Equatable {
    case single
    case multiple
    case none
}

// MARK: - Helpers

/// Recursively strip Optional boxing from dictionary values so that
/// NSDictionary equality compares the underlying values, not Optional wrappers.
/// Swift's `as [String: Any]` cast on a `[String: Any?]` preserves the Optional
/// wrapper (e.g., `Optional(1)`), which NSDictionary treats as a different object
/// than the bare `1`.
private func unwrapOptionals(_ dict: [String: Any?]) -> [String: Any] {
    var result: [String: Any] = [:]
    for (key, value) in dict {
        guard let value = value else { continue }
        if let nested = value as? [String: Any?] {
            result[key] = unwrapOptionals(nested)
        } else if let array = value as? [Any?] {
            result[key] = unwrapOptionalsInArray(array)
        } else {
            result[key] = value
        }
    }
    return result
}

/// Recursively strip Optional boxing from array elements.
/// nil elements are preserved as NSNull() so that positional nulls affect equality
/// (e.g., [1, nil, 3] is not equal to [1, 3]).
private func unwrapOptionalsInArray(_ array: [Any?]) -> [Any] {
    return array.map { element -> Any in
        guard let element = element else { return NSNull() }
        if let nested = element as? [String: Any?] {
            return unwrapOptionals(nested)
        } else if let nestedArray = element as? [Any?] {
            return unwrapOptionalsInArray(nestedArray)
        } else {
            return element
        }
    }
}

// MARK: - Surface Data Models

public struct CardSurfaceData: @unchecked Sendable, Equatable {
    public let title: String
    public let subtitle: String?
    public let body: String
    public let metadata: [(label: String, value: String)]?
    /// Optional template name for specialized rendering (e.g. "weather_forecast").
    public let template: String?
    /// Arbitrary data consumed by the template renderer. Shape depends on template.
    public let templateData: [String: Any?]?

    public init(title: String, subtitle: String? = nil, body: String, metadata: [(label: String, value: String)]? = nil, template: String? = nil, templateData: [String: Any?]? = nil) {
        self.title = title
        self.subtitle = subtitle
        self.body = body
        self.metadata = metadata
        self.template = template
        self.templateData = templateData
    }

    public static func == (lhs: CardSurfaceData, rhs: CardSurfaceData) -> Bool {
        guard lhs.title == rhs.title,
              lhs.subtitle == rhs.subtitle,
              lhs.body == rhs.body,
              lhs.template == rhs.template else { return false }

        // Compare metadata tuple arrays
        switch (lhs.metadata, rhs.metadata) {
        case (.none, .none):
            break
        case let (.some(l), .some(r)):
            guard l.count == r.count && zip(l, r).allSatisfy({ $0.label == $1.label && $0.value == $1.value }) else { return false }
        default:
            return false
        }

        // Compare templateData via NSDictionary bridging (handles nested Any values).
        // We must unwrap Optional boxing first: casting [String: Any?] to [String: Any]
        // preserves Optional(...) wrappers, making logically equal values compare unequal.
        switch (lhs.templateData, rhs.templateData) {
        case (.none, .none):
            return true
        case let (.some(l), .some(r)):
            return NSDictionary(dictionary: unwrapOptionals(l)).isEqual(to: unwrapOptionals(r))
        default:
            return false
        }
    }
}

public struct FormFieldOption: Sendable, Equatable {
    public let label: String
    public let value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }
}

public enum FormFieldType: String, Sendable, Equatable {
    case text
    case textarea
    case select
    case toggle
    case number
    case password
}

/// A form field default value that can be a string, number, or boolean,
/// matching the `string | number | boolean` union in message-protocol.ts.
public enum FormFieldDefault: Sendable, Equatable {
    case string(String)
    case number(Double)
    case boolean(Bool)

    /// Convenience accessor that returns the value as a display string.
    public var stringValue: String {
        switch self {
        case .string(let s): return s
        case .number(let n):
            // Format integers without a decimal point.
            if n == n.rounded(.towardZero) && !n.isNaN && !n.isInfinite {
                return String(Int(n))
            }
            return String(n)
        case .boolean(let b): return b ? "true" : "false"
        }
    }

    /// Parse from an untyped Any value coming from JSON.
    public static func from(_ value: Any?) -> FormFieldDefault? {
        guard let value = value else { return nil }
        // Check Bool before numeric types because Bool conforms to numeric protocols in Swift.
        if let b = value as? Bool { return .boolean(b) }
        if let n = value as? Double { return .number(n) }
        if let n = value as? Int { return .number(Double(n)) }
        if let s = value as? String { return .string(s) }
        return nil
    }
}

public struct FormField: Identifiable, Sendable, Equatable {
    public let id: String
    public let type: FormFieldType
    public let label: String
    public let placeholder: String?
    public let required: Bool
    public let defaultValue: FormFieldDefault?
    public let options: [FormFieldOption]?

    public init(id: String, type: FormFieldType, label: String, placeholder: String? = nil, required: Bool, defaultValue: FormFieldDefault? = nil, options: [FormFieldOption]? = nil) {
        self.id = id
        self.type = type
        self.label = label
        self.placeholder = placeholder
        self.required = required
        self.defaultValue = defaultValue
        self.options = options
    }
}

public struct FormPage: Identifiable, Sendable, Equatable {
    public let id: String
    public let title: String
    public let description: String?
    public let fields: [FormField]

    public init(id: String, title: String, description: String? = nil, fields: [FormField]) {
        self.id = id
        self.title = title
        self.description = description
        self.fields = fields
    }
}

public struct FormPageLabels: Sendable, Equatable {
    public let next: String?
    public let back: String?
    public let submit: String?

    public init(next: String? = nil, back: String? = nil, submit: String? = nil) {
        self.next = next
        self.back = back
        self.submit = submit
    }
}

public struct FormSurfaceData: Sendable, Equatable {
    public let description: String?
    public let fields: [FormField]
    public let submitLabel: String?
    public let pages: [FormPage]?
    public let pageLabels: FormPageLabels?

    public init(description: String? = nil, fields: [FormField], submitLabel: String? = nil, pages: [FormPage]? = nil, pageLabels: FormPageLabels? = nil) {
        self.description = description
        self.fields = fields
        self.submitLabel = submitLabel
        self.pages = pages
        self.pageLabels = pageLabels
    }
}

public struct ListItemData: Identifiable, Sendable, Equatable {
    public let id: String
    public let title: String
    public let subtitle: String?
    public let icon: String?
    public let selected: Bool

    public init(id: String, title: String, subtitle: String? = nil, icon: String? = nil, selected: Bool) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.icon = icon
        self.selected = selected
    }
}

public struct ListSurfaceData: Sendable, Equatable {
    public let items: [ListItemData]
    public let selectionMode: SelectionMode

    public init(items: [ListItemData], selectionMode: SelectionMode) {
        self.items = items
        self.selectionMode = selectionMode
    }
}

public struct ConfirmationSurfaceData: Sendable, Equatable {
    public let message: String
    public let detail: String?
    public let confirmLabel: String?
    public let confirmedLabel: String?
    public let cancelLabel: String?
    public let destructive: Bool

    public init(message: String, detail: String? = nil, confirmLabel: String? = nil, confirmedLabel: String? = nil, cancelLabel: String? = nil, destructive: Bool) {
        self.message = message
        self.detail = detail
        self.confirmLabel = confirmLabel
        self.confirmedLabel = confirmedLabel
        self.cancelLabel = cancelLabel
        self.destructive = destructive
    }
}

public struct DynamicPagePreview: Sendable, Equatable {
    public let title: String
    public let subtitle: String?
    public let description: String?
    public let icon: String?
    public let metrics: [(label: String, value: String)]?
    public let context: String?
    public var previewImage: String?

    public init(title: String, subtitle: String? = nil, description: String? = nil, icon: String? = nil, metrics: [(label: String, value: String)]? = nil, context: String? = nil, previewImage: String? = nil) {
        self.title = title
        self.subtitle = subtitle
        self.description = description
        self.icon = icon
        self.metrics = metrics
        self.context = context
        self.previewImage = previewImage
    }

    public static func == (lhs: DynamicPagePreview, rhs: DynamicPagePreview) -> Bool {
        guard lhs.title == rhs.title,
              lhs.subtitle == rhs.subtitle,
              lhs.description == rhs.description,
              lhs.icon == rhs.icon,
              lhs.previewImage == rhs.previewImage,
              lhs.context == rhs.context else { return false }
        switch (lhs.metrics, rhs.metrics) {
        case (.none, .none):
            return true
        case let (.some(l), .some(r)):
            return l.count == r.count && zip(l, r).allSatisfy { $0.label == $1.label && $0.value == $1.value }
        default:
            return false
        }
    }
}

public struct DynamicPageSurfaceData: Sendable, Equatable {
    public let html: String
    public let width: Int?
    public let height: Int?
    public let appId: String?
    public let appType: String?
    public var preview: DynamicPagePreview?
    public let reloadGeneration: Int?
    public let status: String?

    public init(html: String, width: Int? = nil, height: Int? = nil, appId: String? = nil, appType: String? = nil, preview: DynamicPagePreview? = nil, reloadGeneration: Int? = nil, status: String? = nil) {
        self.html = html
        self.width = width
        self.height = height
        self.appId = appId
        self.appType = appType
        self.preview = preview
        self.reloadGeneration = reloadGeneration
        self.status = status
    }
}

public struct FileUploadSurfaceData: Sendable, Equatable {
    public let prompt: String
    public let acceptedTypes: [String]?
    public let maxFiles: Int
    public let maxSizeBytes: Int

    public init(prompt: String, acceptedTypes: [String]? = nil, maxFiles: Int, maxSizeBytes: Int) {
        self.prompt = prompt
        self.acceptedTypes = acceptedTypes
        self.maxFiles = maxFiles
        self.maxSizeBytes = maxSizeBytes
    }
}

public struct DocumentPreviewSurfaceData: Sendable, Equatable {
    public let title: String
    public let surfaceId: String
    public let subtitle: String?

    public init(title: String, surfaceId: String, subtitle: String? = nil) {
        self.title = title
        self.surfaceId = surfaceId
        self.subtitle = subtitle
    }
}

public struct TableColumn: Identifiable, Sendable, Equatable {
    public let id: String
    public let label: String
    public let width: Int?

    public init(id: String, label: String, width: Int? = nil) {
        self.id = id
        self.label = label
        self.width = width
    }
}

public struct TableCellValue: Sendable, Equatable {
    public let text: String
    public let icon: String?       // SF Symbol name
    public let iconColor: String?  // "success" | "warning" | "error" | "muted"

    public init(text: String, icon: String? = nil, iconColor: String? = nil) {
        self.text = text
        self.icon = icon
        self.iconColor = iconColor
    }
}

public struct TableRow: Identifiable, Sendable, Equatable {
    public let id: String
    public let cells: [String: TableCellValue]
    public let selectable: Bool
    public let selected: Bool

    public init(id: String, cells: [String: TableCellValue], selectable: Bool, selected: Bool) {
        self.id = id
        self.cells = cells
        self.selectable = selectable
        self.selected = selected
    }
}

public struct TableSurfaceData: Sendable, Equatable {
    public let columns: [TableColumn]
    public let rows: [TableRow]
    public let selectionMode: SelectionMode
    public let caption: String?

    public init(columns: [TableColumn], rows: [TableRow], selectionMode: SelectionMode, caption: String? = nil) {
        self.columns = columns
        self.rows = rows
        self.selectionMode = selectionMode
        self.caption = caption
    }
}

public enum SurfaceData: Sendable, Equatable {
    case card(CardSurfaceData)
    case form(FormSurfaceData)
    case list(ListSurfaceData)
    case table(TableSurfaceData)
    case confirmation(ConfirmationSurfaceData)
    case dynamicPage(DynamicPageSurfaceData)
    case fileUpload(FileUploadSurfaceData)
    case documentPreview(DocumentPreviewSurfaceData)
    /// Placeholder for data that was cleared during memory compaction.
    /// The surface can be re-fetched from the daemon if the user scrolls back.
    case stripped
    /// Re-fetch was attempted but failed after exhausting retries.
    case strippedFailed
}

public struct SurfaceActionButton: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let style: SurfaceActionStyle
    /// Optional data payload sent back to the daemon when this action is clicked.
    public let data: [String: AnyCodable]?
    private let index: Int

    /// Unique identity for SwiftUI ForEach. Multiple actions can share the same
    /// `id` (e.g. "relay_prompt"), so we combine id + index to disambiguate.
    public var uniqueId: String { "\(id)-\(index)" }

    public init(id: String, label: String, style: SurfaceActionStyle, data: [String: AnyCodable]? = nil, index: Int = 0) {
        self.id = id
        self.label = label
        self.style = style
        self.data = data
        self.index = index
    }

    public static func == (lhs: SurfaceActionButton, rhs: SurfaceActionButton) -> Bool {
        lhs.id == rhs.id && lhs.label == rhs.label && lhs.style == rhs.style && lhs.index == rhs.index && lhs.data == rhs.data
    }
}

public struct Surface: Identifiable, Sendable {
    public let id: String
    public let sessionId: String?
    public let type: SurfaceType
    public let title: String?
    public let data: SurfaceData
    public let actions: [SurfaceActionButton]

    public init(id: String, sessionId: String?, type: SurfaceType, title: String? = nil, data: SurfaceData, actions: [SurfaceActionButton]) {
        self.id = id
        self.sessionId = sessionId
        self.type = type
        self.title = title
        self.data = data
        self.actions = actions
    }
}

// MARK: - Parsing from Messages

public extension Surface {
    /// Parse a `Surface` from a `UiSurfaceShowMessage` received from the daemon.
    /// The message carries an `AnyCodable` data payload whose shape depends on `surfaceType`.
    static func from(_ message: UiSurfaceShowMessage) -> Surface? {
        guard let surfaceType = SurfaceType(rawValue: message.surfaceType) else {
            return nil
        }

        var dict = message.data.value as? [String: Any?] ?? [:]

        // For cards, the LLM sometimes puts `title` at the top-level tool input
        // rather than inside `data`. If `data` has no title, fall back to the
        // message-level title so the card isn't silently dropped.
        if surfaceType == .card, dict["title"] == nil || (dict["title"] as? String)?.isEmpty == true,
           let fallbackTitle = message.title, !fallbackTitle.isEmpty {
            dict["title"] = fallbackTitle
        }

        guard let surfaceData = parseSurfaceData(type: surfaceType, dict: dict) else {
            return nil
        }

        let actions = (message.actions ?? []).enumerated().map { index, action in
            SurfaceActionButton(
                id: action.id,
                label: action.label,
                style: SurfaceActionStyle(rawValue: action.style ?? "secondary") ?? .secondary,
                data: action.data,
                index: index
            )
        }

        return Surface(
            id: message.surfaceId,
            sessionId: message.sessionId,
            type: surfaceType,
            title: message.title,
            data: surfaceData,
            actions: actions
        )
    }

    /// Create a Surface from a history response surface.
    /// Used when populating messages from history.
    static func from(_ historySurface: HistoryResponseSurface, sessionId: String?) -> Surface? {
        guard let surfaceType = SurfaceType(rawValue: historySurface.surfaceType) else {
            return nil
        }

        var dict = historySurface.data.mapValues { $0.value } as [String: Any?]

        // Same card-title fallback as the live path (see from(UiSurfaceShowMessage)).
        if surfaceType == .card, dict["title"] == nil || (dict["title"] as? String)?.isEmpty == true,
           let fallbackTitle = historySurface.title, !fallbackTitle.isEmpty {
            dict["title"] = fallbackTitle
        }

        guard let surfaceData = parseSurfaceData(type: surfaceType, dict: dict) else {
            return nil
        }

        let actions = (historySurface.actions ?? []).enumerated().map { index, action in
            SurfaceActionButton(
                id: action.id,
                label: action.label,
                style: SurfaceActionStyle(rawValue: action.style ?? "secondary") ?? .secondary,
                data: action.data,
                index: index
            )
        }

        return Surface(
            id: historySurface.surfaceId,
            sessionId: sessionId,
            type: surfaceType,
            title: historySurface.title,
            data: surfaceData,
            actions: actions
        )
    }

    /// Update only the data payload of an existing surface from a `UiSurfaceUpdateMessage`.
    ///
    /// The update payload is `Partial<SurfaceData>` — only the fields present in the dict are
    /// applied over the existing data. Missing keys keep their current value.
    func updated(with message: UiSurfaceUpdateMessage) -> Surface? {
        let dict = message.data.value as? [String: Any?] ?? [:]
        guard let mergedData = Self.mergeSurfaceData(existing: self.data, update: dict) else {
            return nil
        }
        return Surface(
            id: self.id,
            sessionId: self.sessionId,
            type: self.type,
            title: self.title,
            data: mergedData,
            actions: self.actions
        )
    }

    // MARK: - Private Helpers

    /// Parse a `SurfaceData` from a JSON HTTP response containing `surfaceType` and `data` keys.
    /// Shared by `DaemonClient` and `HTTPTransport` to avoid duplicating the extraction logic.
    static func parseSurfaceDataFromResponse(_ responseData: Data) -> SurfaceData? {
        guard let json = try? JSONSerialization.jsonObject(with: responseData) as? [String: Any],
              let surfaceTypeRaw = json["surfaceType"] as? String,
              let surfaceType = SurfaceType(rawValue: surfaceTypeRaw),
              let dataDict = json["data"] as? [String: Any?] else {
            return nil
        }
        return parseSurfaceData(type: surfaceType, dict: dataDict)
    }

    static func parseSurfaceData(type: SurfaceType, dict: [String: Any?]) -> SurfaceData? {
        switch type {
        case .card:
            return parseCardData(dict).map { .card($0) }
        case .form:
            return parseFormData(dict).map { .form($0) }
        case .list:
            return parseListData(dict).map { .list($0) }
        case .table:
            return parseTableData(dict).map { .table($0) }
        case .confirmation:
            return parseConfirmationData(dict).map { .confirmation($0) }
        case .dynamicPage:
            return parseDynamicPageData(dict).map { .dynamicPage($0) }
        case .fileUpload:
            return parseFileUploadData(dict).map { .fileUpload($0) }
        case .documentPreview:
            return parseDocumentPreviewData(dict).map { .documentPreview($0) }
        }
    }

    // MARK: - Partial Merge Helpers

    /// Merge a partial update dict into existing `SurfaceData`, keeping fields that are not
    /// present in the update unchanged. This supports the `Partial<SurfaceData>` contract
    /// from message-protocol.ts.
    private static func mergeSurfaceData(existing: SurfaceData, update: [String: Any?]) -> SurfaceData? {
        switch existing {
        case .card(let card):
            return .card(mergeCardData(existing: card, update: update))
        case .form(let form):
            return .form(mergeFormData(existing: form, update: update))
        case .list(let list):
            return .list(mergeListData(existing: list, update: update))
        case .confirmation(let confirmation):
            return .confirmation(mergeConfirmationData(existing: confirmation, update: update))
        case .table(let table):
            return .table(mergeTableData(existing: table, update: update))
        case .dynamicPage(let dp):
            return .dynamicPage(mergeDynamicPageData(existing: dp, update: update))
        case .fileUpload(let fu):
            return .fileUpload(mergeFileUploadData(existing: fu, update: update))
        case .documentPreview(let dp):
            return .documentPreview(dp)
        case .stripped:
            return .stripped
        case .strippedFailed:
            return .strippedFailed
        }
    }

    private static func mergeCardData(existing: CardSurfaceData, update: [String: Any?]) -> CardSurfaceData {
        let title = (update["title"] as? String) ?? existing.title
        let body = (update["body"] as? String) ?? existing.body
        let subtitle: String? = update.keys.contains("subtitle") ? (update["subtitle"] as? String) : existing.subtitle

        var metadata = existing.metadata
        if update.keys.contains("metadata") {
            if let metaArray = update["metadata"] as? [[String: Any?]] {
                metadata = metaArray.compactMap { item in
                    guard let label = item["label"] as? String,
                          let value = item["value"] as? String else { return nil }
                    return (label: label, value: value)
                }
            } else {
                metadata = nil
            }
        }

        let template: String? = update.keys.contains("template")
            ? (update["template"] as? String) : existing.template
        let templateData: [String: Any?]? = update.keys.contains("templateData")
            ? (update["templateData"] as? [String: Any?]) : existing.templateData

        return CardSurfaceData(title: title, subtitle: subtitle, body: body, metadata: metadata, template: template, templateData: templateData)
    }

    private static func mergeFormData(existing: FormSurfaceData, update: [String: Any?]) -> FormSurfaceData {
        let description: String? = update.keys.contains("description")
            ? (update["description"] as? String)
            : existing.description
        let submitLabel: String? = update.keys.contains("submitLabel")
            ? (update["submitLabel"] as? String)
            : existing.submitLabel

        var fields = existing.fields
        if let fieldsArray = update["fields"] as? [[String: Any?]] {
            fields = parseFormFields(fieldsArray)
        }

        var pages = existing.pages
        if let pagesArray = update["pages"] as? [[String: Any?]] {
            pages = pagesArray.compactMap { pageDict -> FormPage? in
                guard let id = pageDict["id"] as? String,
                      let title = pageDict["title"] as? String else { return nil }
                let pageFields: [FormField]
                if let pf = pageDict["fields"] as? [[String: Any?]] {
                    pageFields = parseFormFields(pf)
                } else {
                    pageFields = []
                }
                return FormPage(id: id, title: title, description: pageDict["description"] as? String, fields: pageFields)
            }
        }

        var pageLabels = existing.pageLabels
        if let labelsDict = update["pageLabels"] as? [String: Any?] {
            pageLabels = FormPageLabels(
                next: labelsDict["next"] as? String,
                back: labelsDict["back"] as? String,
                submit: labelsDict["submit"] as? String
            )
        }

        return FormSurfaceData(description: description, fields: fields, submitLabel: submitLabel, pages: pages, pageLabels: pageLabels)
    }

    private static func mergeListData(existing: ListSurfaceData, update: [String: Any?]) -> ListSurfaceData {
        var items = existing.items
        if let itemsArray = update["items"] as? [[String: Any?]] {
            items = itemsArray.compactMap { itemDict in
                guard let id = itemDict["id"] as? String,
                      let title = itemDict["title"] as? String else {
                    return nil
                }
                return ListItemData(
                    id: id,
                    title: title,
                    subtitle: itemDict["subtitle"] as? String,
                    icon: itemDict["icon"] as? String,
                    selected: itemDict["selected"] as? Bool ?? false
                )
            }
        }

        let selectionMode: SelectionMode
        if let modeStr = update["selectionMode"] as? String,
           let mode = SelectionMode(rawValue: modeStr) {
            selectionMode = mode
        } else {
            selectionMode = existing.selectionMode
        }

        return ListSurfaceData(items: items, selectionMode: selectionMode)
    }

    private static func mergeConfirmationData(existing: ConfirmationSurfaceData, update: [String: Any?]) -> ConfirmationSurfaceData {
        let message = (update["message"] as? String) ?? existing.message
        let detail: String? = update.keys.contains("detail") ? (update["detail"] as? String) : existing.detail
        let confirmLabel: String? = update.keys.contains("confirmLabel")
            ? (update["confirmLabel"] as? String) : existing.confirmLabel
        let confirmedLabel: String? = update.keys.contains("confirmedLabel")
            ? (update["confirmedLabel"] as? String) : existing.confirmedLabel
        let cancelLabel: String? = update.keys.contains("cancelLabel")
            ? (update["cancelLabel"] as? String) : existing.cancelLabel
        let destructive: Bool = (update["destructive"] as? Bool) ?? existing.destructive

        return ConfirmationSurfaceData(
            message: message,
            detail: detail,
            confirmLabel: confirmLabel,
            confirmedLabel: confirmedLabel,
            cancelLabel: cancelLabel,
            destructive: destructive
        )
    }

    private static func mergeDynamicPageData(existing: DynamicPageSurfaceData, update: [String: Any?]) -> DynamicPageSurfaceData {
        let html = (update["html"] as? String) ?? existing.html
        let width: Int? = update.keys.contains("width") ? (update["width"] as? Int) : existing.width
        let height: Int? = update.keys.contains("height") ? (update["height"] as? Int) : existing.height
        let appId: String? = update.keys.contains("appId") ? (update["appId"] as? String) : existing.appId
        let appType: String? = update.keys.contains("appType") ? (update["appType"] as? String) : existing.appType
        let preview: DynamicPagePreview? = update.keys.contains("preview")
            ? parseDynamicPagePreview(update["preview"] as? [String: Any?])
            : existing.preview
        let reloadGeneration: Int? = update.keys.contains("reloadGeneration") ? (update["reloadGeneration"] as? Int) : existing.reloadGeneration
        let status: String? = update.keys.contains("status") ? (update["status"] as? String) : existing.status
        return DynamicPageSurfaceData(html: html, width: width, height: height, appId: appId, appType: appType, preview: preview, reloadGeneration: reloadGeneration, status: status)
    }
    // MARK: - Field Parsing Helpers

    private static func parseFormFields(_ fieldsArray: [[String: Any?]]) -> [FormField] {
        return fieldsArray.compactMap { fieldDict in
            guard let id = fieldDict["id"] as? String,
                  let typeStr = fieldDict["type"] as? String,
                  let fieldType = FormFieldType(rawValue: typeStr),
                  let label = fieldDict["label"] as? String else {
                return nil
            }

            var options: [FormFieldOption]?
            if let optionsArray = fieldDict["options"] as? [[String: Any?]] {
                options = optionsArray.compactMap { optDict in
                    guard let label = optDict["label"] as? String,
                          let value = optDict["value"] as? String else { return nil }
                    return FormFieldOption(label: label, value: value)
                }
            }

            return FormField(
                id: id,
                type: fieldType,
                label: label,
                placeholder: fieldDict["placeholder"] as? String,
                required: fieldDict["required"] as? Bool ?? false,
                defaultValue: FormFieldDefault.from(fieldDict["defaultValue"] as Any?),
                options: options
            )
        }
    }

    // MARK: - Full Parse Helpers

    private static func parseCardData(_ dict: [String: Any?]) -> CardSurfaceData? {
        // Title is required for cards, but fall back to empty string rather
        // than silently dropping the entire surface when the LLM omits it.
        let title = (dict["title"] as? String) ?? ""
        guard !title.isEmpty || (dict["body"] as? String) != nil || dict["template"] != nil else {
            // Neither title, body, nor template — genuinely invalid card data.
            return nil
        }

        let body = (dict["body"] as? String) ?? ""
        let subtitle = dict["subtitle"] as? String
        let template = dict["template"] as? String
        let templateData = dict["templateData"] as? [String: Any?]

        var metadata: [(label: String, value: String)]?
        if let metaArray = dict["metadata"] as? [[String: Any?]] {
            metadata = metaArray.compactMap { item in
                guard let label = item["label"] as? String,
                      let value = item["value"] as? String else { return nil }
                return (label: label, value: value)
            }
        }

        return CardSurfaceData(
            title: title,
            subtitle: subtitle,
            body: body,
            metadata: metadata,
            template: template,
            templateData: templateData
        )
    }

    private static func parseFormData(_ dict: [String: Any?]) -> FormSurfaceData? {
        // Pages mode OR flat fields mode
        let fields: [FormField]
        if let fieldsArray = dict["fields"] as? [[String: Any?]] {
            fields = parseFormFields(fieldsArray)
        } else {
            fields = []
        }

        let description = dict["description"] as? String
        let submitLabel = dict["submitLabel"] as? String

        var pages: [FormPage]?
        if let pagesArray = dict["pages"] as? [[String: Any?]] {
            pages = pagesArray.compactMap { pageDict -> FormPage? in
                guard let id = pageDict["id"] as? String,
                      let title = pageDict["title"] as? String else { return nil }
                let pageFields: [FormField]
                if let pf = pageDict["fields"] as? [[String: Any?]] {
                    pageFields = parseFormFields(pf)
                } else {
                    pageFields = []
                }
                return FormPage(id: id, title: title, description: pageDict["description"] as? String, fields: pageFields)
            }
        }

        var pageLabels: FormPageLabels?
        if let labelsDict = dict["pageLabels"] as? [String: Any?] {
            pageLabels = FormPageLabels(
                next: labelsDict["next"] as? String,
                back: labelsDict["back"] as? String,
                submit: labelsDict["submit"] as? String
            )
        }

        // Need at least fields or pages
        if fields.isEmpty && (pages?.isEmpty ?? true) {
            return nil
        }

        return FormSurfaceData(
            description: description,
            fields: fields,
            submitLabel: submitLabel,
            pages: pages,
            pageLabels: pageLabels
        )
    }

    private static func parseListData(_ dict: [String: Any?]) -> ListSurfaceData? {
        guard let itemsArray = dict["items"] as? [[String: Any?]] else {
            return nil
        }

        let selectionModeStr = dict["selectionMode"] as? String ?? "none"
        let selectionMode = SelectionMode(rawValue: selectionModeStr) ?? .none

        let items: [ListItemData] = itemsArray.compactMap { itemDict in
            guard let id = itemDict["id"] as? String,
                  let title = itemDict["title"] as? String else {
                return nil
            }
            return ListItemData(
                id: id,
                title: title,
                subtitle: itemDict["subtitle"] as? String,
                icon: itemDict["icon"] as? String,
                selected: itemDict["selected"] as? Bool ?? false
            )
        }

        return ListSurfaceData(items: items, selectionMode: selectionMode)
    }

    private static func parseConfirmationData(_ dict: [String: Any?]) -> ConfirmationSurfaceData? {
        guard let message = dict["message"] as? String else {
            return nil
        }

        return ConfirmationSurfaceData(
            message: message,
            detail: dict["detail"] as? String,
            confirmLabel: dict["confirmLabel"] as? String,
            confirmedLabel: dict["confirmedLabel"] as? String,
            cancelLabel: dict["cancelLabel"] as? String,
            destructive: dict["destructive"] as? Bool ?? false
        )
    }

    private static func parseDynamicPageData(_ dict: [String: Any?]) -> DynamicPageSurfaceData? {
        let html = dict["html"] as? String ?? ""
        return DynamicPageSurfaceData(
            html: html,
            width: dict["width"] as? Int,
            height: dict["height"] as? Int,
            appId: dict["appId"] as? String,
            appType: dict["appType"] as? String,
            preview: parseDynamicPagePreview(dict["preview"] as? [String: Any?]),
            reloadGeneration: dict["reloadGeneration"] as? Int,
            status: dict["status"] as? String
        )
    }
    private static func parseDynamicPagePreview(_ dict: [String: Any?]?) -> DynamicPagePreview? {
        guard let dict = dict, let title = dict["title"] as? String else { return nil }
        var metrics: [(label: String, value: String)]?
        if let metricsArray = dict["metrics"] as? [[String: Any?]] {
            metrics = metricsArray.compactMap { item in
                guard let label = item["label"] as? String,
                      let value = item["value"] as? String else { return nil }
                return (label: label, value: value)
            }
        }
        return DynamicPagePreview(
            title: title,
            subtitle: dict["subtitle"] as? String,
            description: dict["description"] as? String,
            icon: dict["icon"] as? String,
            metrics: metrics,
            context: dict["context"] as? String,
            previewImage: dict["previewImage"] as? String
        )
    }

    private static func parseTableData(_ dict: [String: Any?]) -> TableSurfaceData? {
        guard let columnsArray = dict["columns"] as? [[String: Any?]],
              let rowsArray = dict["rows"] as? [[String: Any?]] else {
            return nil
        }

        let columns: [TableColumn] = columnsArray.compactMap { colDict in
            guard let id = colDict["id"] as? String,
                  let label = colDict["label"] as? String else { return nil }
            return TableColumn(id: id, label: label, width: colDict["width"] as? Int)
        }

        let rows: [TableRow] = rowsArray.compactMap { rowDict in
            guard let id = rowDict["id"] as? String,
                  let cellsRaw = rowDict["cells"] as? [String: Any?] else { return nil }
            let cells: [String: TableCellValue] = cellsRaw.compactMapValues { raw -> TableCellValue? in
                if let s = raw as? String { return TableCellValue(text: s) }
                if let d = raw as? [String: Any?], let text = d["text"] as? String {
                    return TableCellValue(text: text, icon: d["icon"] as? String, iconColor: d["iconColor"] as? String)
                }
                return nil
            }
            return TableRow(
                id: id,
                cells: cells,
                selectable: rowDict["selectable"] as? Bool ?? false,
                selected: rowDict["selected"] as? Bool ?? false
            )
        }

        let selectionModeStr = dict["selectionMode"] as? String ?? "none"
        let selectionMode = SelectionMode(rawValue: selectionModeStr) ?? .none
        let caption = dict["caption"] as? String

        return TableSurfaceData(columns: columns, rows: rows, selectionMode: selectionMode, caption: caption)
    }

    private static func mergeTableData(existing: TableSurfaceData, update: [String: Any?]) -> TableSurfaceData {
        var columns = existing.columns
        if let columnsArray = update["columns"] as? [[String: Any?]] {
            columns = columnsArray.compactMap { colDict in
                guard let id = colDict["id"] as? String,
                      let label = colDict["label"] as? String else { return nil }
                return TableColumn(id: id, label: label, width: colDict["width"] as? Int)
            }
        }

        var rows = existing.rows
        if let rowsArray = update["rows"] as? [[String: Any?]] {
            rows = rowsArray.compactMap { rowDict in
                guard let id = rowDict["id"] as? String,
                      let cellsRaw = rowDict["cells"] as? [String: Any?] else { return nil }
                let cells: [String: TableCellValue] = cellsRaw.compactMapValues { raw -> TableCellValue? in
                    if let s = raw as? String { return TableCellValue(text: s) }
                    if let d = raw as? [String: Any?], let text = d["text"] as? String {
                        return TableCellValue(text: text, icon: d["icon"] as? String, iconColor: d["iconColor"] as? String)
                    }
                    return nil
                }
                return TableRow(
                    id: id,
                    cells: cells,
                    selectable: rowDict["selectable"] as? Bool ?? false,
                    selected: rowDict["selected"] as? Bool ?? false
                )
            }
        }

        let selectionMode: SelectionMode
        if let modeStr = update["selectionMode"] as? String,
           let mode = SelectionMode(rawValue: modeStr) {
            selectionMode = mode
        } else {
            selectionMode = existing.selectionMode
        }

        let caption: String? = update.keys.contains("caption")
            ? (update["caption"] as? String) : existing.caption

        return TableSurfaceData(columns: columns, rows: rows, selectionMode: selectionMode, caption: caption)
    }

    private static func parseFileUploadData(_ dict: [String: Any?]) -> FileUploadSurfaceData? {
        guard let prompt = dict["prompt"] as? String else { return nil }
        let acceptedTypes = dict["acceptedTypes"] as? [String]
        let maxFiles = dict["maxFiles"] as? Int ?? 1
        let maxSizeBytes = dict["maxSizeBytes"] as? Int ?? (50 * 1024 * 1024)
        return FileUploadSurfaceData(
            prompt: prompt,
            acceptedTypes: acceptedTypes,
            maxFiles: maxFiles,
            maxSizeBytes: maxSizeBytes
        )
    }

    private static func mergeFileUploadData(existing: FileUploadSurfaceData, update: [String: Any?]) -> FileUploadSurfaceData {
        let prompt = (update["prompt"] as? String) ?? existing.prompt
        let acceptedTypes: [String]? = update.keys.contains("acceptedTypes")
            ? (update["acceptedTypes"] as? [String])
            : existing.acceptedTypes
        let maxFiles = (update["maxFiles"] as? Int) ?? existing.maxFiles
        let maxSizeBytes = (update["maxSizeBytes"] as? Int) ?? existing.maxSizeBytes
        return FileUploadSurfaceData(
            prompt: prompt,
            acceptedTypes: acceptedTypes,
            maxFiles: maxFiles,
            maxSizeBytes: maxSizeBytes
        )
    }

    // MARK: - Browser View Helpers

    /// Convert an untyped value to Double, accepting both Int and Double.
    /// AnyCodable decodes whole-number JSON numbers as Int before Double,
    /// so we need to handle both types.
    private static func asDouble(_ value: Any?) -> Double? {
        if let d = value as? Double { return d }
        if let i = value as? Int { return Double(i) }
        return nil
    }

    private static func parseDocumentPreviewData(_ dict: [String: Any?]) -> DocumentPreviewSurfaceData? {
        guard let title = dict["title"] as? String,
              let surfaceId = dict["surfaceId"] as? String else { return nil }
        return DocumentPreviewSurfaceData(title: title, surfaceId: surfaceId, subtitle: dict["subtitle"] as? String)
    }

}

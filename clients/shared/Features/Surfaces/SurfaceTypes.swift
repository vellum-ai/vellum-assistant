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
}

public enum SurfaceActionStyle: String, Codable, Sendable {
    case primary
    case secondary
    case destructive
}

public enum SelectionMode: String, Sendable {
    case single
    case multiple
    case none
}

// MARK: - Surface Data Models

public struct CardSurfaceData: @unchecked Sendable {
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
}

public struct FormFieldOption: Sendable {
    public let label: String
    public let value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }
}

public enum FormFieldType: String, Sendable {
    case text
    case textarea
    case select
    case toggle
    case number
    case password
}

/// A form field default value that can be a string, number, or boolean,
/// matching the `string | number | boolean` union in ipc-protocol.ts.
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

    /// Parse from an untyped Any value coming from IPC JSON.
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

public struct FormField: Identifiable, Sendable {
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

public struct FormSurfaceData: Sendable {
    public let description: String?
    public let fields: [FormField]
    public let submitLabel: String?

    public init(description: String? = nil, fields: [FormField], submitLabel: String? = nil) {
        self.description = description
        self.fields = fields
        self.submitLabel = submitLabel
    }
}

public struct ListItemData: Identifiable, Sendable {
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

public struct ListSurfaceData: Sendable {
    public let items: [ListItemData]
    public let selectionMode: SelectionMode

    public init(items: [ListItemData], selectionMode: SelectionMode) {
        self.items = items
        self.selectionMode = selectionMode
    }
}

public struct ConfirmationSurfaceData: Sendable {
    public let message: String
    public let detail: String?
    public let confirmLabel: String?
    public let cancelLabel: String?
    public let destructive: Bool

    public init(message: String, detail: String? = nil, confirmLabel: String? = nil, cancelLabel: String? = nil, destructive: Bool) {
        self.message = message
        self.detail = detail
        self.confirmLabel = confirmLabel
        self.cancelLabel = cancelLabel
        self.destructive = destructive
    }
}

public struct DynamicPageSurfaceData: Sendable {
    public let html: String
    public let width: Int?
    public let height: Int?
    public let appId: String?

    public init(html: String, width: Int? = nil, height: Int? = nil, appId: String? = nil) {
        self.html = html
        self.width = width
        self.height = height
        self.appId = appId
    }
}

public struct FileUploadSurfaceData: Sendable {
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

public struct TableColumn: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let width: Int?

    public init(id: String, label: String, width: Int? = nil) {
        self.id = id
        self.label = label
        self.width = width
    }
}

public struct TableRow: Identifiable, Sendable {
    public let id: String
    public let cells: [String: String]
    public let selectable: Bool
    public let selected: Bool

    public init(id: String, cells: [String: String], selectable: Bool, selected: Bool) {
        self.id = id
        self.cells = cells
        self.selectable = selectable
        self.selected = selected
    }
}

public struct TableSurfaceData: Sendable {
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

public enum SurfaceData: Sendable {
    case card(CardSurfaceData)
    case form(FormSurfaceData)
    case list(ListSurfaceData)
    case table(TableSurfaceData)
    case confirmation(ConfirmationSurfaceData)
    case dynamicPage(DynamicPageSurfaceData)
    case fileUpload(FileUploadSurfaceData)
}

public struct SurfaceActionButton: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let style: SurfaceActionStyle

    public init(id: String, label: String, style: SurfaceActionStyle) {
        self.id = id
        self.label = label
        self.style = style
    }
}

public struct Surface: Identifiable, Sendable {
    public let id: String
    public let sessionId: String
    public let type: SurfaceType
    public let title: String?
    public let data: SurfaceData
    public let actions: [SurfaceActionButton]

    public init(id: String, sessionId: String, type: SurfaceType, title: String? = nil, data: SurfaceData, actions: [SurfaceActionButton]) {
        self.id = id
        self.sessionId = sessionId
        self.type = type
        self.title = title
        self.data = data
        self.actions = actions
    }
}

// MARK: - Parsing from IPC Messages

public extension Surface {
    /// Parse a `Surface` from a `UiSurfaceShowMessage` received over IPC.
    /// The message carries an `AnyCodable` data payload whose shape depends on `surfaceType`.
    static func from(_ message: UiSurfaceShowMessage) -> Surface? {
        guard let surfaceType = SurfaceType(rawValue: message.surfaceType) else {
            return nil
        }

        let dict = message.data.value as? [String: Any?] ?? [:]

        guard let surfaceData = parseSurfaceData(type: surfaceType, dict: dict) else {
            return nil
        }

        let actions = (message.actions ?? []).map { action in
            SurfaceActionButton(
                id: action.id,
                label: action.label,
                style: SurfaceActionStyle(rawValue: action.style ?? "secondary") ?? .secondary
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

    private static func parseSurfaceData(type: SurfaceType, dict: [String: Any?]) -> SurfaceData? {
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
        }
    }

    // MARK: - Partial Merge Helpers

    /// Merge a partial update dict into existing `SurfaceData`, keeping fields that are not
    /// present in the update unchanged. This supports the `Partial<SurfaceData>` contract
    /// from ipc-protocol.ts.
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

        return FormSurfaceData(description: description, fields: fields, submitLabel: submitLabel)
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
        let cancelLabel: String? = update.keys.contains("cancelLabel")
            ? (update["cancelLabel"] as? String) : existing.cancelLabel
        let destructive: Bool = (update["destructive"] as? Bool) ?? existing.destructive

        return ConfirmationSurfaceData(
            message: message,
            detail: detail,
            confirmLabel: confirmLabel,
            cancelLabel: cancelLabel,
            destructive: destructive
        )
    }

    private static func mergeDynamicPageData(existing: DynamicPageSurfaceData, update: [String: Any?]) -> DynamicPageSurfaceData {
        let html = (update["html"] as? String) ?? existing.html
        let width: Int? = update.keys.contains("width") ? (update["width"] as? Int) : existing.width
        let height: Int? = update.keys.contains("height") ? (update["height"] as? Int) : existing.height
        let appId: String? = update.keys.contains("appId") ? (update["appId"] as? String) : existing.appId
        return DynamicPageSurfaceData(html: html, width: width, height: height, appId: appId)
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
        guard let title = dict["title"] as? String else {
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
        guard let fieldsArray = dict["fields"] as? [[String: Any?]] else {
            return nil
        }

        let description = dict["description"] as? String
        let submitLabel = dict["submitLabel"] as? String
        let fields = parseFormFields(fieldsArray)

        return FormSurfaceData(
            description: description,
            fields: fields,
            submitLabel: submitLabel
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
            cancelLabel: dict["cancelLabel"] as? String,
            destructive: dict["destructive"] as? Bool ?? false
        )
    }

    private static func parseDynamicPageData(_ dict: [String: Any?]) -> DynamicPageSurfaceData? {
        guard let html = dict["html"] as? String else { return nil }
        return DynamicPageSurfaceData(
            html: html,
            width: dict["width"] as? Int,
            height: dict["height"] as? Int,
            appId: dict["appId"] as? String
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
            let cells = cellsRaw.compactMapValues { $0 as? String }
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
                let cells = cellsRaw.compactMapValues { $0 as? String }
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
}

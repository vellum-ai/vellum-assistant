import Foundation

// MARK: - Surface Enums

enum SurfaceType: String, Codable, Sendable {
    case card
    case form
    case list
    case table
    case confirmation
    case dynamicPage = "dynamic_page"
    case fileUpload = "file_upload"
}

enum SurfaceActionStyle: String, Codable, Sendable {
    case primary
    case secondary
    case destructive
}

enum SelectionMode: String, Sendable {
    case single
    case multiple
    case none
}

// MARK: - Surface Data Models

struct CardSurfaceData: Sendable {
    let title: String
    let subtitle: String?
    let body: String
    let metadata: [(label: String, value: String)]?
}

struct FormFieldOption: Sendable {
    let label: String
    let value: String
}

enum FormFieldType: String, Sendable {
    case text
    case textarea
    case select
    case toggle
    case number
}

/// A form field default value that can be a string, number, or boolean,
/// matching the `string | number | boolean` union in ipc-protocol.ts.
enum FormFieldDefault: Sendable, Equatable {
    case string(String)
    case number(Double)
    case boolean(Bool)

    /// Convenience accessor that returns the value as a display string.
    var stringValue: String {
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
    static func from(_ value: Any?) -> FormFieldDefault? {
        guard let value = value else { return nil }
        // Check Bool before numeric types because Bool conforms to numeric protocols in Swift.
        if let b = value as? Bool { return .boolean(b) }
        if let n = value as? Double { return .number(n) }
        if let n = value as? Int { return .number(Double(n)) }
        if let s = value as? String { return .string(s) }
        return nil
    }
}

struct FormField: Identifiable, Sendable {
    let id: String
    let type: FormFieldType
    let label: String
    let placeholder: String?
    let required: Bool
    let defaultValue: FormFieldDefault?
    let options: [FormFieldOption]?
}

struct FormSurfaceData: Sendable {
    let description: String?
    let fields: [FormField]
    let submitLabel: String?
}

struct ListItemData: Identifiable, Sendable {
    let id: String
    let title: String
    let subtitle: String?
    let icon: String?
    let selected: Bool
}

struct ListSurfaceData: Sendable {
    let items: [ListItemData]
    let selectionMode: SelectionMode
}

struct ConfirmationSurfaceData: Sendable {
    let message: String
    let detail: String?
    let confirmLabel: String?
    let cancelLabel: String?
    let destructive: Bool
}

struct DynamicPageSurfaceData: Sendable {
    let html: String
    let width: Int?
    let height: Int?
    let appId: String?
}

struct FileUploadSurfaceData: Sendable {
    let prompt: String
    let acceptedTypes: [String]?
    let maxFiles: Int
    let maxSizeBytes: Int
}

struct TableColumn: Identifiable, Sendable {
    let id: String
    let label: String
    let width: Int?
}

struct TableRow: Identifiable, Sendable {
    let id: String
    let cells: [String: String]
    let selectable: Bool
    let selected: Bool
}

struct TableSurfaceData: Sendable {
    let columns: [TableColumn]
    let rows: [TableRow]
    let selectionMode: SelectionMode
    let caption: String?
}

enum SurfaceData: Sendable {
    case card(CardSurfaceData)
    case form(FormSurfaceData)
    case list(ListSurfaceData)
    case table(TableSurfaceData)
    case confirmation(ConfirmationSurfaceData)
    case dynamicPage(DynamicPageSurfaceData)
    case fileUpload(FileUploadSurfaceData)
}

struct SurfaceActionButton: Identifiable, Sendable {
    let id: String
    let label: String
    let style: SurfaceActionStyle
}

struct Surface: Identifiable, Sendable {
    let id: String
    let sessionId: String
    let type: SurfaceType
    let title: String?
    let data: SurfaceData
    let actions: [SurfaceActionButton]
}

// MARK: - Parsing from IPC Messages

extension Surface {
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

        return CardSurfaceData(title: title, subtitle: subtitle, body: body, metadata: metadata)
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
        guard let title = dict["title"] as? String,
              let body = dict["body"] as? String else {
            return nil
        }

        let subtitle = dict["subtitle"] as? String

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
            metadata: metadata
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

import Foundation

// MARK: - Surface Enums

enum SurfaceType: String, Codable, Sendable {
    case card
    case form
    case list
    case confirmation
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

struct FormField: Identifiable, Sendable {
    let id: String
    let type: FormFieldType
    let label: String
    let placeholder: String?
    let required: Bool
    let defaultValue: String?
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

enum SurfaceData: Sendable {
    case card(CardSurfaceData)
    case form(FormSurfaceData)
    case list(ListSurfaceData)
    case confirmation(ConfirmationSurfaceData)
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
    func updated(with message: UiSurfaceUpdateMessage) -> Surface? {
        let dict = message.data.value as? [String: Any?] ?? [:]
        guard let newData = Self.parseSurfaceData(type: self.type, dict: dict) else {
            return nil
        }
        return Surface(
            id: self.id,
            sessionId: self.sessionId,
            type: self.type,
            title: self.title,
            data: newData,
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
        case .confirmation:
            return parseConfirmationData(dict).map { .confirmation($0) }
        }
    }

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

        let fields: [FormField] = fieldsArray.compactMap { fieldDict in
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
                defaultValue: fieldDict["defaultValue"] as? String,
                options: options
            )
        }

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
}

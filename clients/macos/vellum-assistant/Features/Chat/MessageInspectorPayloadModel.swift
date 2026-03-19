import Foundation
import VellumAssistantShared

enum MessageInspectorPayloadViewMode: String, Hashable {
    case tree
    case source

    var label: String {
        switch self {
        case .tree:
            return "Tree"
        case .source:
            return "Source"
        }
    }
}

struct MessageInspectorPayloadModel: Equatable {
    let source: String
    let isTreeAvailable: Bool
    var viewMode: MessageInspectorPayloadViewMode {
        didSet {
            if !isTreeAvailable, viewMode != .source {
                viewMode = .source
            }
        }
    }

    init(payload: AnyCodable, preferredViewMode: MessageInspectorPayloadViewMode = .tree) {
        if let string = payload.value as? String {
            source = string
            isTreeAvailable = false
            viewMode = .source
            return
        }

        self.init(
            source: Self.renderSource(from: payload),
            preferredViewMode: preferredViewMode
        )
    }

    init(source: String, preferredViewMode: MessageInspectorPayloadViewMode = .tree) {
        self.source = source
        isTreeAvailable = Self.canRenderTree(source: source)
        viewMode = isTreeAvailable ? preferredViewMode : .source
    }

    var availableViewModes: [MessageInspectorPayloadViewMode] {
        isTreeAvailable ? [.tree, .source] : [.source]
    }

    var showsViewModePicker: Bool {
        availableViewModes.count > 1
    }

    var showsExpandCollapseActions: Bool {
        isTreeAvailable && viewMode == .tree
    }

    static func canRenderTree(source: String) -> Bool {
        let trimmedSource = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSource.isEmpty, let data = trimmedSource.data(using: .utf8) else {
            return false
        }

        do {
            _ = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
            return true
        } catch {
            return false
        }
    }

    private static func renderSource(from payload: AnyCodable) -> String {
        guard let value = payload.value else {
            return "null"
        }

        if let object = wrapJSONObject(value) {
            do {
                let data = try JSONSerialization.data(
                    withJSONObject: object,
                    options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
                )
                return String(data: data, encoding: .utf8) ?? String(describing: value)
            } catch {
                return String(describing: value)
            }
        }

        if isJSONFragment(value) {
            do {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
                let data = try encoder.encode(payload)
                return String(data: data, encoding: .utf8) ?? String(describing: value)
            } catch {
                return String(describing: value)
            }
        }

        return String(describing: value)
    }

    private static func wrapJSONObject(_ value: Any) -> Any? {
        if let dict = value as? [String: Any?] {
            return dict.reduce(into: [String: Any]()) { result, pair in
                result[pair.key] = pair.value.flatMap { wrapJSONObjectValue($0) } ?? NSNull()
            }
        }

        if let array = value as? [Any?] {
            return array.map { $0.flatMap { wrapJSONObjectValue($0) } ?? NSNull() }
        }

        return nil
    }

    private static func wrapJSONObjectValue(_ value: Any) -> Any? {
        if let wrappedObject = wrapJSONObject(value) {
            return wrappedObject
        }
        return isJSONFragment(value) ? value : nil
    }

    private static func isJSONFragment(_ value: Any) -> Bool {
        switch value {
        case is String, is Int, is Double, is Bool, is NSNull:
            return true
        case is NSNumber:
            return true
        default:
            return false
        }
    }
}

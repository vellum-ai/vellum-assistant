import Foundation
import VellumAssistantShared

// MARK: - Domain Types

public enum NativePanelId: String, Equatable, Sendable {
    case chat, conversationList, settings, debug, generated, avatarCustomization, apps, intelligence, usageDashboard
}

extension NativePanelId: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        // Legacy values from older builds — map appropriately
        switch rawValue {
        case "identity", "agent":
            self = .intelligence
        // Legacy Home Base panel — map to apps as a reasonable fallback
        case "directory":
            self = .apps
        // Legacy Task Queue panel — removed, degrade gracefully
        case "taskQueue":
            self = .chat
        // Legacy threadList panel — renamed to conversationList
        case "threadList":
            self = .conversationList
        default:
            guard let value = NativePanelId(rawValue: rawValue) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Unknown NativePanelId: \(rawValue)"
                )
            }
            self = value
        }
    }
}

public enum SlotContent: Equatable, Sendable {
    case native(NativePanelId)
    case surface(surfaceId: String)
    case empty
}

extension SlotContent: Codable {
    private enum CodingKeys: String, CodingKey {
        case type, panel, surfaceId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "native":
            // Decode the raw string and try to match it to a known panel ID.
            // If the value is stale (e.g. a removed panel like "assistantInbox"),
            // degrade to .empty instead of failing the entire layout decode.
            let rawPanel = try container.decode(String.self, forKey: .panel)
            // Handle legacy panel IDs that were renamed or removed
            switch rawPanel {
            case "identity", "agent":
                self = .native(.intelligence)
            case "directory":
                self = .native(.apps)
            case "taskQueue":
                self = .native(.chat)
            // Legacy threadList panel — renamed to conversationList
            case "threadList":
                self = .native(.conversationList)
            default:
                if let panel = NativePanelId(rawValue: rawPanel) {
                    self = .native(panel)
                } else {
                    self = .empty
                }
            }
        case "surface":
            let surfaceId = try container.decode(String.self, forKey: .surfaceId)
            self = .surface(surfaceId: surfaceId)
        case "empty":
            self = .empty
        default:
            self = .empty
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .native(let panelId):
            try container.encode("native", forKey: .type)
            try container.encode(panelId, forKey: .panel)
        case .surface(let surfaceId):
            try container.encode("surface", forKey: .type)
            try container.encode(surfaceId, forKey: .surfaceId)
        case .empty:
            try container.encode("empty", forKey: .type)
        }
    }
}

public struct SlotConfig: Codable, Equatable, Sendable {
    public var content: SlotContent
    public var width: Double?
    public var visible: Bool
}

public struct LayoutConfig: Codable, Equatable, Sendable {
    public var version: Int
    public var left: SlotConfig
    public var center: SlotConfig
    public var right: SlotConfig

    public static let `default` = LayoutConfig(
        version: 1,
        left: SlotConfig(content: .native(.conversationList), width: 240, visible: true),
        center: SlotConfig(content: .native(.chat), width: nil, visible: true),
        right: SlotConfig(content: .empty, width: 400, visible: false)
    )
}

// MARK: - Merge Logic

extension LayoutConfig {
    public static func merged(base: LayoutConfig, wire: UiLayoutConfigMessage) -> LayoutConfig {
        var result = base
        if let left = wire.left { result.left = SlotConfig.merged(base: base.left, wire: left) }
        if let center = wire.center { result.center = SlotConfig.merged(base: base.center, wire: center) }
        if let right = wire.right { result.right = SlotConfig.merged(base: base.right, wire: right) }
        return result
    }
}

extension SlotConfig {
    static func merged(base: SlotConfig, wire: SlotConfigWire) -> SlotConfig {
        var result = base
        if let content = wire.content { result.content = SlotContent.from(wire: content) ?? base.content }
        // Tri-state width: .none = field missing (keep base), .some(nil) = explicit null (reset), .some(value) = update
        if let widthUpdate = wire.width {
            result.width = widthUpdate
        }
        if let visible = wire.visible { result.visible = visible }
        return result
    }
}

extension SlotContent {
    static func from(wire: SlotContentWire) -> SlotContent? {
        switch wire.type {
        case "native":
            guard let panel = wire.panel else { return nil }
            // Handle legacy panel IDs that were renamed or removed
            let id: NativePanelId
            switch panel {
            case "identity", "agent":
                id = .intelligence
            // Legacy Home Base panel — map to apps as a reasonable fallback
            case "directory":
                id = .apps
            // Legacy Task Queue panel — removed, degrade gracefully
            case "taskQueue":
                id = .chat
            // Legacy threadList panel — renamed to conversationList
            case "threadList":
                id = .conversationList
            default:
                guard let parsed = NativePanelId(rawValue: panel) else { return nil }
                id = parsed
            }
            return .native(id)
        case "surface":
            guard let surfaceId = wire.surfaceId else { return nil }
            return .surface(surfaceId: surfaceId)
        case "empty":
            return .empty
        default:
            return nil
        }
    }
}

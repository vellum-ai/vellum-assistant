import Foundation
import VellumAssistantShared

// MARK: - Domain Types

public enum NativePanelId: String, Codable, Equatable, Sendable {
    case chat, threadList, settings, agent, debug, doctor, directory, generated, identity, avatarCustomization, voiceMode
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
            let panel = try container.decode(NativePanelId.self, forKey: .panel)
            self = .native(panel)
        case "surface":
            let surfaceId = try container.decode(String.self, forKey: .surfaceId)
            self = .surface(surfaceId: surfaceId)
        case "empty":
            self = .empty
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown SlotContent type: \(type)"
            )
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
        left: SlotConfig(content: .native(.threadList), width: 240, visible: true),
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
            guard let panel = wire.panel, let id = NativePanelId(rawValue: panel) else { return nil }
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

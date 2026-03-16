import Foundation
import CoreGraphics

enum ActionType: String, Codable {
    case click
    case doubleClick = "double_click"
    case rightClick = "right_click"
    case type
    case key
    case scroll
    case wait
    case done
    case drag
    case openApp = "open_app"
    case runAppleScript = "run_applescript"
    case respond
}

enum ActionTargetMode: String, Codable {
    case ax
    case vision
    case mixed
    case unknown
}

struct AgentAction: Codable {
    let type: ActionType
    var x: CGFloat?
    var y: CGFloat?
    var text: String?
    var key: String?
    var scrollDirection: String?
    var scrollAmount: Int?
    var toX: CGFloat?
    var toY: CGFloat?
    var summary: String?
    var waitDuration: Int?
    var appName: String?
    var script: String?
    var reasoning: String
    var resolvedFromElementId: Int?
    var resolvedToElementId: Int?
    var elementDescription: String?

    init(
        type: ActionType,
        reasoning: String,
        x: CGFloat? = nil,
        y: CGFloat? = nil,
        toX: CGFloat? = nil,
        toY: CGFloat? = nil,
        text: String? = nil,
        key: String? = nil,
        scrollDirection: String? = nil,
        scrollAmount: Int? = nil,
        summary: String? = nil,
        waitDuration: Int? = nil,
        appName: String? = nil,
        script: String? = nil,
        resolvedFromElementId: Int? = nil,
        resolvedToElementId: Int? = nil,
        elementDescription: String? = nil
    ) {
        self.type = type
        self.reasoning = reasoning
        self.x = x
        self.y = y
        self.toX = toX
        self.toY = toY
        self.text = text
        self.key = key
        self.scrollDirection = scrollDirection
        self.scrollAmount = scrollAmount
        self.summary = summary
        self.waitDuration = waitDuration
        self.appName = appName
        self.script = script
        self.resolvedFromElementId = resolvedFromElementId
        self.resolvedToElementId = resolvedToElementId
        self.elementDescription = elementDescription
    }

    var targetMode: ActionTargetMode {
        let hasIdTargets = resolvedFromElementId != nil || resolvedToElementId != nil
        let hasPointTargets = (x != nil && y != nil) || (toX != nil && toY != nil)
        if hasIdTargets && hasPointTargets { return .mixed }
        if hasIdTargets { return .ax }
        if hasPointTargets { return .vision }
        return .unknown
    }

    var displayDescription: String {
        switch type {
        case .click:
            if let id = resolvedFromElementId, let desc = elementDescription {
                return "Click [\(id)] \(desc) (\(targetMode.rawValue))"
            }
            if let x = x, let y = y {
                return "Click at (\(Int(x)), \(Int(y))) (\(targetMode.rawValue))"
            }
            return "Click"
        case .doubleClick:
            if let id = resolvedFromElementId, let desc = elementDescription {
                return "Double-click [\(id)] \(desc) (\(targetMode.rawValue))"
            }
            if let x = x, let y = y {
                return "Double-click at (\(Int(x)), \(Int(y))) (\(targetMode.rawValue))"
            }
            return "Double-click"
        case .rightClick:
            if let id = resolvedFromElementId, let desc = elementDescription {
                return "Right-click [\(id)] \(desc) (\(targetMode.rawValue))"
            }
            if let x = x, let y = y {
                return "Right-click at (\(Int(x)), \(Int(y))) (\(targetMode.rawValue))"
            }
            return "Right-click"
        case .type:
            if let text = text {
                let preview = text.count > 40 ? String(text.prefix(40)) + "..." : text
                return "Type \"\(preview)\""
            }
            return "Type"
        case .key:
            if let key = key {
                return "Press \(key)"
            }
            return "Press key"
        case .scroll:
            let dir = scrollDirection ?? "down"
            let amt = scrollAmount ?? 3
            return "Scroll \(dir) \(amt)x (\(targetMode.rawValue))"
        case .wait:
            if let ms = waitDuration {
                return "Wait \(ms)ms"
            }
            return "Wait"
        case .drag:
            if let fromId = resolvedFromElementId, let toId = resolvedToElementId {
                return "Drag [\(fromId)] to [\(toId)] (\(targetMode.rawValue))"
            }
            if let x = x, let y = y, let tx = toX, let ty = toY {
                return "Drag from (\(Int(x)),\(Int(y))) to (\(Int(tx)),\(Int(ty))) (\(targetMode.rawValue))"
            }
            return "Drag"
        case .openApp:
            if let name = appName {
                return "Open app: \(name)"
            }
            return "Open app"
        case .runAppleScript:
            if let script = script {
                let preview = script.count > 60 ? String(script.prefix(60)) + "..." : script
                return "AppleScript: \(preview)"
            }
            return "AppleScript"
        case .done:
            if let summary = summary {
                let preview = summary.count > 60 ? String(summary.prefix(60)) + "..." : summary
                return "Done: \(preview)"
            }
            return "Done"
        case .respond:
            if let summary = summary {
                let preview = summary.count > 60 ? String(summary.prefix(60)) + "..." : summary
                return "Response: \(preview)"
            }
            return "Response"
        }
    }
}

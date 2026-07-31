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
        self.waitDuration = waitDuration
        self.appName = appName
        self.script = script
        self.resolvedFromElementId = resolvedFromElementId
        self.resolvedToElementId = resolvedToElementId
        self.elementDescription = elementDescription
    }
}

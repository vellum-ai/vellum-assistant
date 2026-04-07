enum SidePanelType: Hashable, CaseIterable {
    case home
    case generated
    case settings
    case debug
    case documentEditor
    case avatarCustomization
    case apps
    case intelligence
    case usageDashboard

    init?(rawValue: String) {
        switch rawValue {
        case "home": self = .home
        case "generated": self = .generated
        case "settings": self = .settings
        case "debug": self = .debug
        case "documentEditor": self = .documentEditor
        case "avatarCustomization": self = .avatarCustomization
        case "apps": self = .apps
        case "intelligence": self = .intelligence
        case "usageDashboard": self = .usageDashboard
        // Legacy values from older builds — map to the unified Intelligence panel
        case "identity", "agent": self = .intelligence
        // Legacy Home Base panel — map to apps as a reasonable fallback
        case "directory": self = .apps
        // Legacy Task Queue panel — removed, fall back to intelligence
        case "taskQueue": self = .intelligence
        default: return nil
        }
    }
}

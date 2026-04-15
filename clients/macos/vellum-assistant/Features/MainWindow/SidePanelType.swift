enum SidePanelType: Hashable, CaseIterable {
    case generated
    case settings
    case logsAndUsage
    case documentEditor
    case avatarCustomization
    case apps
    case intelligence
    case home

    init?(rawValue: String) {
        switch rawValue {
        case "generated": self = .generated
        case "settings": self = .settings
        case "logsAndUsage": self = .logsAndUsage
        case "documentEditor": self = .documentEditor
        case "avatarCustomization": self = .avatarCustomization
        case "apps": self = .apps
        case "intelligence": self = .intelligence
        case "home": self = .home
        // Legacy values — map to the unified Logs & Usage panel
        case "debug", "usageDashboard": self = .logsAndUsage
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

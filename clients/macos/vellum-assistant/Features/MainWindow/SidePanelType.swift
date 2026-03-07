enum SidePanelType: Hashable, CaseIterable {
    case generated
    case settings
    case directory
    case debug
    case documentEditor
    case avatarCustomization
    case apps
    case intelligence
    case usageDashboard

    init?(rawValue: String) {
        switch rawValue {
        case "generated": self = .generated
        case "settings": self = .settings
        case "directory": self = .directory
        case "debug": self = .debug
        case "documentEditor": self = .documentEditor
        case "avatarCustomization": self = .avatarCustomization
        case "apps": self = .apps
        case "intelligence": self = .intelligence
        case "usageDashboard": self = .usageDashboard
        // Legacy values from older builds — map to the unified Intelligence panel
        case "identity", "agent": self = .intelligence
        default: return nil
        }
    }
}

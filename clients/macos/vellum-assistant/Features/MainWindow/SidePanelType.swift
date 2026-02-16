enum SidePanelType: Hashable, CaseIterable {
    case generated
    case agent
    case settings
    case directory
    case debug
    case doctor
    case activity

    init?(rawValue: String) {
        switch rawValue {
        case "generated": self = .generated
        case "agent": self = .agent
        case "settings": self = .settings
        case "directory": self = .directory
        case "debug": self = .debug
        case "doctor": self = .doctor
        case "activity": self = .activity
        default: return nil
        }
    }
}

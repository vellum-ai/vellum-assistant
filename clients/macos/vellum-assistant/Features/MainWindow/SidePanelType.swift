enum SidePanelType: Hashable, CaseIterable {
    case generated
    case agent
    case settings
    case directory
    case debug
    case doctor
    case activity
    case identity
    case documentEditor
    case taskQueue
    case avatarCustomization

    init?(rawValue: String) {
        switch rawValue {
        case "generated": self = .generated
        case "agent": self = .agent
        case "settings": self = .settings
        case "directory": self = .directory
        case "debug": self = .debug
        case "doctor": self = .doctor
        case "activity": self = .activity
        case "identity": self = .identity
        case "documentEditor": self = .documentEditor
        case "taskQueue": self = .taskQueue
        case "avatarCustomization": self = .avatarCustomization
        default: return nil
        }
    }
}

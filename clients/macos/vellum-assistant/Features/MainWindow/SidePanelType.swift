enum SidePanelType: Hashable, CaseIterable {
    case generated
    case agent
    case settings
    case directory
    case debug
    case identity
    case documentEditor
    case avatarCustomization
    case voiceMode
    case assistantInbox
    case apps
    case intelligence

    init?(rawValue: String) {
        switch rawValue {
        case "generated": self = .generated
        case "agent": self = .agent
        case "settings": self = .settings
        case "directory": self = .directory
        case "debug": self = .debug
        case "identity": self = .identity
        case "documentEditor": self = .documentEditor
        case "avatarCustomization": self = .avatarCustomization
        case "voiceMode": self = .voiceMode
        case "assistantInbox": self = .assistantInbox
        case "apps": self = .apps
        case "intelligence": self = .intelligence
        default: return nil
        }
    }
}

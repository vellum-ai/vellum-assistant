enum SidePanelType: Hashable, CaseIterable {
    case generated
    case settings
    case directory
    case debug
    case documentEditor
    case avatarCustomization
    case voiceMode
    case assistantInbox
    case apps
    case intelligence

    init?(rawValue: String) {
        switch rawValue {
        case "generated": self = .generated
        case "settings": self = .settings
        case "directory": self = .directory
        case "debug": self = .debug
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

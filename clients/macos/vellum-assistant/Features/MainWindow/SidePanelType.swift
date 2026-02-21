enum SidePanelType: Hashable, CaseIterable {
    case generated
    case agent
    case settings
    case directory
    case debug
    case doctor
    case identity
    case documentEditor
    case avatarCustomization
    case voiceMode

    init?(rawValue: String) {
        switch rawValue {
        case "generated": self = .generated
        case "agent": self = .agent
        case "settings": self = .settings
        case "directory": self = .directory
        case "debug": self = .debug
        case "doctor": self = .doctor
        case "identity": self = .identity
        case "documentEditor": self = .documentEditor
        case "avatarCustomization": self = .avatarCustomization
        case "voiceMode": self = .voiceMode
        default: return nil
        }
    }
}

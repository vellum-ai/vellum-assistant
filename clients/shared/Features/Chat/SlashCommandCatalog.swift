import Foundation

public enum ChatSlashCommandPlatform: Hashable {
    case macos
    case ios
}

public enum ChatSlashCommandSurface: Hashable, CaseIterable {
    case picker
    case helpBubble
    case sendPath
}

public enum ChatSlashCommandSelectionBehavior: Hashable {
    case autoSend
    case insertTrailingSpace
}

public struct ChatSlashCommandDescriptor: Hashable {
    public let name: String
    public let description: String
    public let icon: String
    public let selectionBehavior: ChatSlashCommandSelectionBehavior
    public let pickerPlatforms: Set<ChatSlashCommandPlatform>
    public let helpBubblePlatforms: Set<ChatSlashCommandPlatform>
    public let sendPathPlatforms: Set<ChatSlashCommandPlatform>
    public let refreshesModelMetadata: Bool

    public init(
        name: String,
        description: String,
        icon: String,
        selectionBehavior: ChatSlashCommandSelectionBehavior,
        pickerPlatforms: Set<ChatSlashCommandPlatform>,
        helpBubblePlatforms: Set<ChatSlashCommandPlatform>,
        sendPathPlatforms: Set<ChatSlashCommandPlatform>,
        refreshesModelMetadata: Bool = false
    ) {
        self.name = name
        self.description = description
        self.icon = icon
        self.selectionBehavior = selectionBehavior
        self.pickerPlatforms = pickerPlatforms
        self.helpBubblePlatforms = helpBubblePlatforms
        self.sendPathPlatforms = sendPathPlatforms
        self.refreshesModelMetadata = refreshesModelMetadata
    }

    public var slashName: String {
        "/\(name)"
    }

    public func isVisible(
        on platform: ChatSlashCommandPlatform,
        surface: ChatSlashCommandSurface
    ) -> Bool {
        platforms(for: surface).contains(platform)
    }

    public func platforms(for surface: ChatSlashCommandSurface) -> Set<ChatSlashCommandPlatform> {
        switch surface {
        case .picker:
            return pickerPlatforms
        case .helpBubble:
            return helpBubblePlatforms
        case .sendPath:
            return sendPathPlatforms
        }
    }
}

public enum ChatSlashCommandCatalog {
    private static let allPlatforms: Set<ChatSlashCommandPlatform> = [.macos, .ios]

    public static let allCommands: [ChatSlashCommandDescriptor] = [
        ChatSlashCommandDescriptor(
            name: "commands",
            description: "List all available commands",
            icon: "terminal",
            selectionBehavior: .autoSend,
            pickerPlatforms: allPlatforms,
            helpBubblePlatforms: allPlatforms,
            sendPathPlatforms: allPlatforms
        ),
        ChatSlashCommandDescriptor(
            name: "models",
            description: "List all available models",
            icon: "list.bullet",
            selectionBehavior: .autoSend,
            pickerPlatforms: allPlatforms,
            helpBubblePlatforms: allPlatforms,
            sendPathPlatforms: allPlatforms,
            refreshesModelMetadata: true
        ),
        ChatSlashCommandDescriptor(
            name: "status",
            description: "Show session status and context usage",
            icon: "info.circle",
            selectionBehavior: .autoSend,
            pickerPlatforms: allPlatforms,
            helpBubblePlatforms: allPlatforms,
            sendPathPlatforms: allPlatforms
        ),
        ChatSlashCommandDescriptor(
            name: "btw",
            description: "Ask a side question while the assistant is working",
            icon: "bubble.left.and.text.bubble.right",
            selectionBehavior: .insertTrailingSpace,
            pickerPlatforms: allPlatforms,
            helpBubblePlatforms: allPlatforms,
            sendPathPlatforms: allPlatforms
        ),
        ChatSlashCommandDescriptor(
            name: "pair",
            description: "Generate pairing info for connecting a mobile device",
            icon: "qrcode",
            selectionBehavior: .autoSend,
            pickerPlatforms: [.macos],
            helpBubblePlatforms: [.macos],
            sendPathPlatforms: allPlatforms
        ),
    ]

    public static func commands(
        for platform: ChatSlashCommandPlatform,
        surface: ChatSlashCommandSurface
    ) -> [ChatSlashCommandDescriptor] {
        allCommands.filter { $0.isVisible(on: platform, surface: surface) }
    }

    public static func normalizedCommandName(from rawInput: String) -> String? {
        let trimmed = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return nil }
        guard let token = trimmed.split(whereSeparator: \.isWhitespace).first else {
            return nil
        }
        let tokenString = String(token)
        guard tokenString.count > 1 else { return nil }
        return String(tokenString.dropFirst()).lowercased()
    }

    public static func descriptor(
        forRawInput rawInput: String,
        platform: ChatSlashCommandPlatform? = nil,
        surface: ChatSlashCommandSurface? = nil
    ) -> ChatSlashCommandDescriptor? {
        guard let commandName = normalizedCommandName(from: rawInput) else {
            return nil
        }
        guard let descriptor = allCommands.first(where: { $0.name == commandName }) else {
            return nil
        }
        if let platform, let surface {
            return descriptor.isVisible(on: platform, surface: surface)
                ? descriptor
                : nil
        }
        if let platform {
            let visibleOnAnySurface = ChatSlashCommandSurface.allCases.contains {
                descriptor.platforms(for: $0).contains(platform)
            }
            return visibleOnAnySurface ? descriptor : nil
        }
        if let surface {
            return descriptor.platforms(for: surface).isEmpty ? nil : descriptor
        }
        return descriptor
    }

    public static func isRecognizedSlashCommand(
        _ rawInput: String,
        platform: ChatSlashCommandPlatform? = nil,
        surface: ChatSlashCommandSurface? = nil
    ) -> Bool {
        descriptor(forRawInput: rawInput, platform: platform, surface: surface) != nil
    }

    public static func shouldRefreshModelMetadata(forRawInput rawInput: String) -> Bool {
        descriptor(forRawInput: rawInput, surface: .sendPath)?.refreshesModelMetadata == true
    }
}

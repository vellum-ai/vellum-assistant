import Foundation

public extension SlackDeepLinks {
    var preferredURL: URL? {
        Self.parse(appUrl) ?? Self.parse(webUrl)
    }

    private static func parse(_ value: String?) -> URL? {
        guard let value, !value.isEmpty else { return nil }
        return URL(string: value)
    }
}

public extension SlackMessageReference {
    var preferredMessageURL: URL? {
        messageLink?.preferredURL
    }

    var preferredThreadURL: URL? {
        threadLink?.preferredURL
    }
}

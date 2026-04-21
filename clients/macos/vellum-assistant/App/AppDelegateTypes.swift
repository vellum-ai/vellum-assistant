import AppKit

enum AssistantStatus {
    case idle
    case thinking
    case error
    case disconnected
    case authFailed

    var menuTitle: String {
        menuTitle(assistantName: nil)
    }

    func menuTitle(assistantName: String?) -> String {
        let name = assistantName ?? "Assistant"
        switch self {
        case .idle: return "\(name) is idle"
        case .thinking: return "\(name) is thinking..."
        case .error: return "\(name) encountered an error"
        case .disconnected: return "Disconnected from \(name)"
        case .authFailed: return "Authentication failed — use Re-pair \(name) below"
        }
    }

    var statusColor: NSColor {
        switch self {
        case .idle: return .systemGray
        case .thinking: return .systemGreen
        case .error: return .systemRed
        case .disconnected: return .systemOrange
        case .authFailed: return .systemYellow
        }
    }

    var statusIcon: NSImage? {
        switch self {
        case .idle:         return Self.idleIcon
        case .thinking:     return Self.thinkingIcon
        case .error:        return Self.errorIcon
        case .disconnected: return Self.disconnectedIcon
        case .authFailed:   return Self.authFailedIcon
        }
    }

    private static let idleIcon         = makeStatusDot(color: .systemGray)
    private static let thinkingIcon     = makeStatusDot(color: .systemGreen)
    private static let errorIcon        = makeStatusDot(color: .systemRed)
    private static let disconnectedIcon = makeStatusDot(color: .systemOrange)
    private static let authFailedIcon   = makeStatusDot(color: .systemYellow)

    private static func makeStatusDot(color: NSColor) -> NSImage {
        let size: CGFloat = 8
        return NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            color.setFill()
            NSBezierPath(ovalIn: rect).fill()
            return true
        }
    }

    /// Whether the dot should pulse (animate opacity)
    var shouldPulse: Bool {
        if case .thinking = self { return true }
        return false
    }
}

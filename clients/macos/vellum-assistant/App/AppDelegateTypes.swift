import AppKit

enum AssistantStatus {
    case idle
    case thinking
    case error(String)
    case disconnected

    var menuTitle: String {
        switch self {
        case .idle: return "Assistant is idle"
        case .thinking: return "Assistant is thinking..."
        case .error(let msg): return "Error: \(msg)"
        case .disconnected: return "Disconnected from assistant"
        }
    }

    var statusColor: NSColor {
        switch self {
        case .idle: return .systemGray
        case .thinking: return .systemGreen
        case .error: return .systemRed
        case .disconnected: return .systemOrange
        }
    }

    var statusIcon: NSImage? {
        let size: CGFloat = 8
        let image = NSImage(size: NSSize(width: size, height: size))
        image.lockFocus()
        statusColor.setFill()
        NSBezierPath(ovalIn: NSRect(x: 0, y: 0, width: size, height: size)).fill()
        image.unlockFocus()
        return image
    }

    /// Whether the dot should pulse (animate opacity)
    var shouldPulse: Bool {
        if case .thinking = self { return true }
        return false
    }
}

import Foundation

/// Shared tool display helpers used by both macOS and iOS clients.
/// Maps raw tool names to user-friendly labels, icons, and progressive status text.
public enum ToolDisplayHelpers {

    /// Maps tool names to user-friendly past-tense labels.
    /// When `inputSummary` is provided, produces contextual labels like "Read config.json".
    public static func friendlyToolLabel(_ toolName: String, inputSummary: String = "") -> String {
        let name = toolName.lowercased()
        let summary = inputSummary
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)

        // Extract just the filename from a file path.
        let fileName: String? = {
            guard !summary.isEmpty else { return nil }
            let last = (summary as NSString).lastPathComponent
            guard !last.isEmpty, last != "." else { return nil }
            return last
        }()

        switch name {
        case "run command":
            if !summary.isEmpty {
                let display = summary.count > 30 ? String(summary.prefix(27)) + "..." : summary
                return "Ran `\(display)`"
            }
            return "Ran a command"
        case "read file":
            if let f = fileName { return "Read \(f)" }
            return "Read a file"
        case "write file":
            if let f = fileName { return "Wrote \(f)" }
            return "Wrote a file"
        case "edit file":
            if let f = fileName { return "Edited \(f)" }
            return "Edited a file"
        case "search files":
            if !summary.isEmpty {
                let display = summary.count > 25 ? String(summary.prefix(22)) + "..." : summary
                return "Searched for '\(display)'"
            }
            return "Searched files"
        case "find files":
            if !summary.isEmpty {
                let display = summary.count > 25 ? String(summary.prefix(22)) + "..." : summary
                return "Searched for \(display)"
            }
            return "Found files"
        case "web search":
            if !summary.isEmpty {
                let display = summary.count > 25 ? String(summary.prefix(22)) + "..." : summary
                return "Searched '\(display)'"
            }
            return "Searched the web"
        case "fetch url":              return "Fetched a webpage"
        case "browser navigate":       return "Opened a page"
        case "browser click":          return "Clicked on the page"
        case "browser screenshot":     return "Took a screenshot"
        case "request system permission":
            return "\(permissionFriendlyName(from: summary)) granted"
        default:                       return "Used \(toolName)"
        }
    }

    /// Plural past-tense labels for multiple tool calls of the same type.
    public static func friendlyToolLabelPlural(_ toolName: String, count: Int) -> String {
        switch toolName.lowercased() {
        case "run command":        return "Ran \(count) commands"
        case "read file":          return "Read \(count) files"
        case "write file":         return "Wrote \(count) files"
        case "edit file":          return "Edited \(count) files"
        case "search files":       return "Ran \(count) searches"
        case "find files":         return "Ran \(count) searches"
        case "web search":         return "Searched the web \(count) times"
        case "fetch url":          return "Fetched \(count) webpages"
        case "browser navigate":   return "Opened \(count) pages"
        case "browser click":      return "Clicked \(count) times"
        case "browser screenshot":  return "Took \(count) screenshots"
        default:                   return "Used \(toolName) \(count) times"
        }
    }

    /// Maps tool names to user-friendly present-tense labels for the running state.
    public static func friendlyRunningLabel(_ toolName: String, inputSummary: String? = nil, buildingStatus: String? = nil) -> String {
        // For app file tools, prefer the descriptive building status from tool input
        if let status = buildingStatus {
            let lower = toolName.lowercased()
            if lower == "app file edit" || lower == "app file write" || lower == "app create" || lower == "app update" {
                return status
            }
        }
        switch toolName.lowercased() {
        case "run command":            return "Running a command"
        case "read file":              return "Reading a file"
        case "write file":             return "Writing a file"
        case "edit file":              return "Editing a file"
        case "search files":           return "Searching files"
        case "find files":             return "Finding files"
        case "web search":             return "Searching the web"
        case "fetch url":              return "Fetching a webpage"
        case "browser navigate":       return "Opening a page"
        case "browser click":          return "Clicking on the page"
        case "browser screenshot":     return "Taking a screenshot"
        case "app create":             return "Building your app"
        case "app update":             return "Updating your app"
        case "skill load":
            if let name = inputSummary, !name.isEmpty {
                let display = name.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
                return "Loading \(display)"
            }
            return "Loading a skill"
        default:                       return "Running \(toolName)"
        }
    }

    /// Progressive labels for long-running tools. Cycles through these over time.
    public static func progressiveLabels(for toolName: String) -> [String] {
        switch toolName.lowercased() {
        case "app create":
            return [
                "Choosing a visual direction",
                "Designing the layout",
                "Writing the interface",
                "Adding styles and colors",
                "Wiring up interactions",
                "Polishing the details",
                "Almost there",
            ]
        case "app update":
            return [
                "Reviewing your app",
                "Applying changes",
                "Updating the interface",
                "Polishing the details",
            ]
        default:
            return []
        }
    }

    /// Icon for a tool category.
    public static func friendlyToolIcon(_ toolName: String) -> String {
        switch toolName.lowercased() {
        case "run command":                                 return "terminal"
        case "read file":                                   return "doc.text"
        case "write file":                                  return "doc.badge.plus"
        case "edit file":                                   return "pencil"
        case "search files", "find files", "web search":    return "magnifyingglass"
        case "fetch url":                                   return "globe"
        case "browser navigate", "browser click":           return "safari"
        case "browser screenshot":                          return "camera"
        case "request system permission":                   return "lock.shield"
        default:                                            return "gearshape"
        }
    }

    /// Convert raw permission_type (e.g. "full_disk_access") to a user-facing label.
    public static func permissionFriendlyName(from rawType: String) -> String {
        switch rawType {
        case "full_disk_access": return "Full Disk Access"
        case "accessibility": return "Accessibility"
        case "screen_recording": return "Screen Recording"
        case "calendar": return "Calendar"
        case "contacts": return "Contacts"
        case "photos": return "Photos"
        case "location": return "Location Services"
        case "microphone": return "Microphone"
        case "camera": return "Camera"
        default:
            if rawType.isEmpty { return "Permission" }
            return rawType.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

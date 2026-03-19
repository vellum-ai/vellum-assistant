import SwiftUI

// MARK: - Tool Label Helpers

extension ChatBubble {
    /// Maps tool names to user-friendly past-tense labels.
    /// When `inputSummary` is provided, produces contextual labels like "Read config.json".
    static func friendlyToolLabel(_ toolName: String, inputSummary: String = "") -> String {
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
            return "\(Self.permissionFriendlyName(from: summary)) granted"
        default:                       return "Used \(toolName)"
        }
    }

    /// Plural past-tense labels for multiple tool calls of the same type.
    static func friendlyToolLabelPlural(_ toolName: String, count: Int) -> String {
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
    static func friendlyRunningLabel(_ toolName: String, inputSummary: String? = nil, buildingStatus: String? = nil) -> String {
        // For app file tools, prefer the descriptive building status from tool input
        if let status = buildingStatus {
            if toolName == "app_create" || toolName == "app_refresh" {
                return status
            }
        }
        switch toolName {
        case "bash", "host_bash":               return "Running a command"
        case "file_read", "host_file_read":     return "Reading a file"
        case "file_write", "host_file_write":   return "Writing a file"
        case "file_edit", "host_file_edit":     return "Editing a file"
        case "grep":                            return "Searching files"
        case "glob":                            return "Finding files"
        case "web_search":                      return "Searching the web"
        case "web_fetch":                       return "Fetching a webpage"
        case "browser_navigate":                return "Opening a page"
        case "browser_click":                   return "Clicking on the page"
        case "browser_screenshot":              return "Taking a screenshot"
        case "app_create":                      return "Building your app"
        case "app_refresh":                     return "Refreshing your app"
        case "skill_load":
            if let name = inputSummary, !name.isEmpty {
                // App-builder skill gets a more contextual label
                if name.contains("app-builder") || name.contains("app_builder") {
                    return "Using App Builder skill"
                }
                let display = name.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
                return "Loading \(display)"
            }
            return "Loading a skill"
        default:
            // Convert raw snake_case name to a readable fallback
            let display = toolName.replacingOccurrences(of: "_", with: " ")
            return "Running \(display)"
        }
    }

    /// Maps tool names to user-facing capability descriptions for completed states.
    /// Returns nil for tools with no friendly mapping, letting callers fall back to a default.
    /// When `buildingStatus` is present, it takes priority as it's already user-friendly.
    static func friendlyCapabilityLabel(_ toolName: String, buildingStatus: String? = nil) -> String? {
        if let status = buildingStatus { return status }
        switch toolName {
        case "app_create":                              return "Building your app"
        case "app_refresh":                             return "Refreshing your app"
        case "skill_load":                              return "Loading skill"
        case "web_search":                              return "Researching"
        case "web_fetch":                               return "Gathering information"
        case "file_read", "host_file_read":             return "Reading files"
        case "file_write", "host_file_write":           return "Creating files"
        case "file_edit", "host_file_edit":             return "Editing files"
        case "bash", "host_bash":                       return "Running commands"
        default:                                        return nil
        }
    }

    /// Progressive labels for long-running tools. Cycles through these over time.
    static func progressiveLabels(for toolName: String) -> [String] {
        switch toolName {
        case "app_create":
            return [
                "Choosing a visual direction",
                "Designing the layout",
                "Writing the interface",
                "Adding styles and colors",
                "Wiring up interactions",
                "Polishing the details",
                "Almost there",
            ]
        case "app_refresh":
            return [
                "Reviewing your app",
                "Applying changes",
                "Refreshing the interface",
                "Polishing the details",
            ]
        default:
            return []
        }
    }

    /// Icon for a tool category.
    static func friendlyToolIcon(_ toolName: String) -> String {
        switch toolName {
        case "bash", "host_bash":                               return "terminal"
        case "file_read", "host_file_read":                     return "doc.text"
        case "file_write", "host_file_write":                   return "doc.badge.plus"
        case "file_edit", "host_file_edit":                     return "pencil"
        case "grep", "glob", "web_search":                      return "magnifyingglass"
        case "web_fetch":                                       return "globe"
        case "browser_navigate", "browser_click":               return "safari"
        case "browser_screenshot":                              return "camera"
        case "request_system_permission":                       return "lock.shield"
        default:                                                return "gearshape"
        }
    }

    /// Convert raw permission_type (e.g. "full_disk_access") to a user-facing label.
    static func permissionFriendlyName(from rawType: String) -> String {
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

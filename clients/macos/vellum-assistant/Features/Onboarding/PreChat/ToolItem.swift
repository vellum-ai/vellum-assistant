import Foundation

struct ToolItem: Identifiable {
    let id: String       // "gmail", "slack", etc.
    let label: String    // "Gmail", "Slack", etc.
    let logoKey: String  // IntegrationLogoBundle provider key, e.g. "google"

    static let allTools: [ToolItem] = [
        ToolItem(id: "gmail", label: "Gmail", logoKey: "gmail"),
        ToolItem(id: "google-calendar", label: "Google Calendar", logoKey: "google-calendar"),
        ToolItem(id: "outlook", label: "Outlook", logoKey: "outlook"),
        ToolItem(id: "slack", label: "Slack", logoKey: "slack"),
        ToolItem(id: "notion", label: "Notion", logoKey: "notion"),
        ToolItem(id: "linear", label: "Linear", logoKey: "linear"),
        ToolItem(id: "figma", label: "Figma", logoKey: "figma"),
        ToolItem(id: "github", label: "GitHub", logoKey: "github"),
        ToolItem(id: "google-docs", label: "Google Docs", logoKey: "google-docs"),
        ToolItem(id: "google-sheets", label: "Google Sheets", logoKey: "google-sheets"),
        ToolItem(id: "google-drive", label: "Google Drive", logoKey: "google-drive"),
        ToolItem(id: "jira", label: "Jira", logoKey: "jira"),
    ]
}

import Foundation

struct ToolItem: Identifiable {
    let id: String        // "gmail", "slack", etc.
    let label: String     // "Gmail", "Slack", etc.
    let assetName: String // asset catalog name, e.g. "tool-gmail"

    static let allTools: [ToolItem] = [
        ToolItem(id: "gmail", label: "Gmail", assetName: "tool-gmail"),
        ToolItem(id: "google-calendar", label: "Google Calendar", assetName: "tool-google-calendar"),
        ToolItem(id: "outlook", label: "Outlook", assetName: "tool-outlook"),
        ToolItem(id: "slack", label: "Slack", assetName: "tool-slack"),
        ToolItem(id: "notion", label: "Notion", assetName: "tool-notion"),
        ToolItem(id: "linear", label: "Linear", assetName: "tool-linear"),
        ToolItem(id: "figma", label: "Figma", assetName: "tool-figma"),
        ToolItem(id: "github", label: "GitHub", assetName: "tool-github"),
        ToolItem(id: "google-docs", label: "Google Docs", assetName: "tool-google-docs"),
        ToolItem(id: "google-sheets", label: "Google Sheets", assetName: "tool-google-sheets"),
        ToolItem(id: "google-drive", label: "Google Drive", assetName: "tool-google-drive"),
        ToolItem(id: "jira", label: "Jira", assetName: "tool-jira"),
    ]
}

import Foundation

/// Data model for dashboard task cards. Each task has a stable ID matching
/// the starter-task playbook so the daemon can reference tasks by ID when
/// sending `dashboard_task_kickoff` messages.
struct DashboardTask: Identifiable, Equatable {
    let id: String
    let emoji: String
    let title: String
    let subtitle: String
    /// The kickoff intent sent to the chat when the CTA is tapped
    /// (e.g. "[STARTER_TASK:make_it_yours]").
    let kickoffIntent: String
    let category: Category

    enum Category: String, CaseIterable {
        case starter
        case deferredPermission
    }
}

// MARK: - Built-in Tasks

extension DashboardTask {
    /// Starter tasks that appear on the dashboard by default.
    static let starterTasks: [DashboardTask] = [
        DashboardTask(
            id: "make_it_yours",
            emoji: "\u{1F3A8}",
            title: "Make it yours",
            subtitle: "Pick a color with your agent",
            kickoffIntent: "[STARTER_TASK:make_it_yours]",
            category: .starter
        ),
        DashboardTask(
            id: "research_topic",
            emoji: "\u{1F50D}",
            title: "Research something for me",
            subtitle: "Ask your agent to dig into any topic",
            kickoffIntent: "[STARTER_TASK:research_topic]",
            category: .starter
        ),
        DashboardTask(
            id: "research_to_ui",
            emoji: "\u{1F310}",
            title: "Turn it into a webpage",
            subtitle: "Transform research into a visual page",
            kickoffIntent: "[STARTER_TASK:research_to_ui]",
            category: .starter
        ),
    ]

    /// Deferred permission tasks that unlock additional capabilities.
    static let deferredPermissionTasks: [DashboardTask] = [
        DashboardTask(
            id: "enable_voice",
            emoji: "\u{1F3A4}",
            title: "Enable voice mode",
            subtitle: "Talk to your agent hands-free",
            kickoffIntent: "[STARTER_TASK:enable_voice]",
            category: .deferredPermission
        ),
        DashboardTask(
            id: "enable_computer_control",
            emoji: "\u{1F5A5}",
            title: "Enable computer control",
            subtitle: "Let your agent interact with your screen",
            kickoffIntent: "[STARTER_TASK:enable_computer_control]",
            category: .deferredPermission
        ),
    ]
}

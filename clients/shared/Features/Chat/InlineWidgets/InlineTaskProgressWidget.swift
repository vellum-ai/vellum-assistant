import SwiftUI

// MARK: - Data Model

public struct TaskStepItem: Identifiable {
    public let id: String
    public let label: String
    public let status: String
    public let detail: String?

    public init(id: String, label: String, status: String, detail: String?) {
        self.id = id
        self.label = label
        self.status = status
        self.detail = detail
    }
}

public struct TaskProgressData {
    public let title: String
    public let status: String
    public let steps: [TaskStepItem]

    public init(title: String, status: String, steps: [TaskStepItem]) {
        self.title = title
        self.status = status
        self.steps = steps
    }

    public static func parse(from dict: [String: Any?], fallbackTitle: String? = nil) -> TaskProgressData? {
        guard let stepsArray = dict["steps"] as? [[String: Any?]] else {
            return nil
        }
        let title = dict["title"] as? String ?? fallbackTitle ?? "Task"

        let status = dict["status"] as? String ?? "in_progress"

        var items: [TaskStepItem] = []
        for (index, entry) in stepsArray.enumerated() {
            let id = entry["id"] as? String ?? "step-\(index)"
            let label = entry["label"] as? String ?? ""
            let stepStatus = entry["status"] as? String ?? "pending"
            let detail = entry["detail"] as? String
            items.append(TaskStepItem(
                id: id,
                label: label,
                status: stepStatus,
                detail: detail
            ))
        }

        return TaskProgressData(
            title: title,
            status: status,
            steps: items
        )
    }
}

// MARK: - Widget View

public struct InlineTaskProgressWidget: View {
    public let data: TaskProgressData

    public init(data: TaskProgressData) {
        self.data = data
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            headerSection
            stepsList
        }
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Header

    private var headerSection: some View {
        HStack(alignment: .center, spacing: VSpacing.sm) {
            Text(data.title)
                .font(VFont.headline)
                .foregroundColor(VColor.contentDefault)

            Spacer()

            statusBadge(for: data.status)
        }
    }

    // MARK: - Status Badge

    private func statusBadge(for status: String) -> some View {
        let (label, icon, color) = statusInfo(for: status)
        return HStack(spacing: VSpacing.xs) {
            VIconView(icon, size: 10)
            Text(label)
                .font(VFont.caption)
        }
        .foregroundColor(color)
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xxs)
        .background(
            Capsule()
                .fill(color.opacity(0.15))
        )
    }

    // MARK: - Steps List

    private var stepsList: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(data.steps.enumerated()), id: \.element.id) { index, step in
                stepRow(step)
                if index < data.steps.count - 1 {
                    Divider().background(VColor.surfaceActive.opacity(0.3))
                }
            }
        }
    }

    private func stepRow(_ step: TaskStepItem) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            stepIcon(for: step.status)
                .frame(width: 20, height: 20)

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(step.label)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)

                if let detail = step.detail {
                    Text(detail)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                }
            }

            Spacer()
        }
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Helpers

    @ViewBuilder
    private func stepIcon(for status: String) -> some View {
        switch status {
        case "completed":
            VIconView(.circleCheck, size: 14)
                .foregroundColor(VColor.systemPositiveStrong)
        case "in_progress":
            ProgressView()
                .controlSize(.small)
                .tint(VColor.systemNegativeHover)
        case "waiting":
            VIconView(.clock, size: 14)
                .foregroundColor(VColor.systemNegativeHover)
        case "failed":
            VIconView(.circleX, size: 14)
                .foregroundColor(VColor.systemNegativeStrong)
        default:
            VIconView(.circle, size: 14)
                .foregroundColor(VColor.contentDisabled)
        }
    }

    private func statusInfo(for status: String) -> (label: String, icon: VIcon, color: Color) {
        switch status {
        case "completed":
            return ("Completed", .circleCheck, VColor.systemPositiveStrong)
        case "in_progress":
            return ("In Progress", .refreshCw, VColor.systemNegativeHover)
        case "waiting":
            return ("Waiting", .clock, VColor.systemNegativeHover)
        case "failed":
            return ("Failed", .circleX, VColor.systemNegativeStrong)
        default:
            return ("Pending", .circle, VColor.contentDisabled)
        }
    }
}

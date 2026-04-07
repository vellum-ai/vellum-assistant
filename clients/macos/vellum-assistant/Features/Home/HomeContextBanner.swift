import SwiftUI
import VellumAssistantShared

/// Ambient context strip at the top of the home feed showing a greeting,
/// time since last session, and count of new items.
struct HomeContextBanner: View {
    let lastSessionDate: Date?
    let newCount: Int

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            Text(greeting)
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentDefault)

            if let lastSessionDate {
                Text("\u{00B7}")
                    .foregroundStyle(VColor.contentTertiary)
                Text("Last session \(relativeTime(since: lastSessionDate))")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }

            if newCount > 0 {
                Text("\u{00B7}")
                    .foregroundStyle(VColor.contentTertiary)
                Text("\(newCount) new")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.primaryBase)
            }

            Spacer()
        }
        .padding(EdgeInsets(top: VSpacing.md, leading: VSpacing.lg, bottom: VSpacing.sm, trailing: VSpacing.lg))
        .accessibilityElement(children: .combine)
    }

    // MARK: - Greeting

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        switch hour {
        case 5..<12: return "Good morning"
        case 12..<17: return "Good afternoon"
        case 17..<22: return "Good evening"
        default: return "Welcome back"
        }
    }

    // MARK: - Relative Time

    private func relativeTime(since date: Date) -> String {
        let interval = Date().timeIntervalSince(date)
        let minutes = Int(interval / 60)
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes) min ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        let days = hours / 24
        return "\(days) day\(days == 1 ? "" : "s") ago"
    }
}

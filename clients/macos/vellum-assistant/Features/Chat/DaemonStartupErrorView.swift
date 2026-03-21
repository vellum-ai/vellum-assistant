import SwiftUI
import VellumAssistantShared

/// Shown when the daemon fails to start with a structured error.
/// Displays a category-specific message, expandable technical details,
/// and a report-to-Vellum action.
struct DaemonStartupErrorView: View {
    let error: DaemonStartupError
    let onSendLogs: () -> Void

    @State private var visible = false

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            VIconView(.triangleAlert, size: 28)
                .foregroundColor(VColor.systemNegativeHover)

            VStack(spacing: VSpacing.sm) {
                Text("Your assistant couldn\u{2019}t start")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.contentDefault)

                Text(subtitleForCategory(error.category))
                    .font(.system(size: 14))
                    .foregroundColor(VColor.contentSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 380)
                    .textSelection(.enabled)
            }

            technicalDetails

            VButton(label: "Report to Vellum", leftIcon: VIcon.send.rawValue, style: .primary) {
                onSendLogs()
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .opacity(visible ? 1 : 0)
        .onAppear {
            withAnimation(VAnimation.standard) {
                visible = true
            }
        }
    }

    // MARK: - Technical Details

    @ViewBuilder
    private var technicalDetails: some View {
        DisclosureGroup("Technical details") {
            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(error.message)
                        .font(VFont.mono)
                        .foregroundColor(VColor.contentTertiary)
                        .textSelection(.enabled)

                    if let detail = error.detail, !detail.isEmpty {
                        Text(detail)
                            .font(VFont.mono)
                            .foregroundColor(VColor.contentTertiary)
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 120)
        }
        .font(VFont.caption)
        .foregroundColor(VColor.contentSecondary)
        .frame(maxWidth: 380)
    }

    // MARK: - Category Messages

    private func subtitleForCategory(_ category: String) -> String {
        switch category {
        case "MIGRATION_FAILED":
            return "A database update failed. Reporting to Vellum will help us fix this."
        case "PORT_IN_USE":
            return "Another process is using the assistant\u{2019}s port. Try quitting other apps and retrying."
        case "DB_LOCKED":
            return "The database is locked by another process. Try retrying in a moment."
        case "DB_CORRUPT":
            return "The database appears to be corrupted. Reporting to Vellum will help us fix this."
        case "ENV_VALIDATION":
            return "There\u{2019}s a configuration issue. Please report to Vellum so we can help."
        default:
            return "Something unexpected happened. Reporting to Vellum will help us investigate."
        }
    }
}

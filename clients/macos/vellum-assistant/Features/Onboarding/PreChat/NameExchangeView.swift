import SwiftUI
import VellumAssistantShared

@MainActor
struct NameExchangeView: View {
    // MARK: - Configuration

    /// Contextual sentence synthesizing prior selections. When empty, a generic
    /// fallback is displayed.
    var contextSummary: String

    @Binding var userName: String
    @Binding var assistantName: String

    var onComplete: () -> Void
    var onSkip: () -> Void

    // MARK: - Private State

    @State private var showHeader = false
    @State private var showContent = false

    /// Quick-tap suggestion pills for the assistant name.
    private static let assistantNameSuggestions = ["Pax", "Atlas", "Sage", "Nova", "Kit"]

    /// Usernames that are clearly not real names and should not be pre-filled.
    private static let usernameBlacklist: Set<String> = ["admin", "user", "root", "guest"]

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            // Header
            Text(headerText)
                .font(VFont.titleLarge)
                .foregroundStyle(VColor.contentDefault)
                .multilineTextAlignment(.center)
                .opacity(showHeader ? 1 : 0)
                .offset(y: showHeader ? 0 : 8)
                .padding(.bottom, VSpacing.xxl)
                .padding(.horizontal, VSpacing.xxl)

            // Form content
            VStack(spacing: VSpacing.lg) {
                // "I'll call you..." field
                VTextField(
                    "I'll call you...",
                    placeholder: "Your name",
                    text: $userName
                )

                // "Call me..." field + suggestion pills
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    VTextField(
                        "Call me...",
                        placeholder: "Assistant name",
                        text: $assistantName
                    )

                    // Suggestion pills
                    HStack(spacing: VSpacing.xs) {
                        ForEach(Self.assistantNameSuggestions, id: \.self) { suggestion in
                            suggestionPill(suggestion)
                        }
                    }
                }

                // Helper note
                Text("You can always change these later.")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, VSpacing.xxl)
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 12)

            Spacer()

            // Footer: primary action + skip
            VStack(spacing: VSpacing.sm) {
                VButton(label: "Let's go", style: .primary, isFullWidth: true) {
                    onComplete()
                }

                VButton(label: "Skip", style: .ghost, tintColor: VColor.contentTertiary) {
                    onSkip()
                }
            }
            .padding(.horizontal, VSpacing.xxl)
            .padding(.bottom, VSpacing.xxl)
            .opacity(showContent ? 1 : 0)
        }
        .onAppear {
            withAnimation(VAnimation.slow.delay(0.1)) {
                showHeader = true
            }
            withAnimation(VAnimation.slow.delay(0.3)) {
                showContent = true
            }
        }
    }

    // MARK: - Subviews

    private func suggestionPill(_ name: String) -> some View {
        Button {
            assistantName = name
        } label: {
            Text(name)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xs)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.pill)
                        .fill(VColor.surfaceLift)
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.pill)
                                .stroke(VColor.borderElement, lineWidth: 1)
                        )
                )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Helpers

    private var headerText: String {
        if !contextSummary.isEmpty {
            return contextSummary
        }
        return "Let's get to know each other."
    }

    /// Determines a suitable pre-fill value for the user name field based on
    /// macOS system user information.
    ///
    /// Returns the full name if it contains a space (indicating a real first+last
    /// name), or the short username if it is longer than 2 characters and does
    /// not match the blacklist. Otherwise returns an empty string.
    static func defaultUserName() -> String {
        let fullName = NSFullUserName()
        if fullName.contains(" ") {
            return fullName
        }

        let shortName = NSUserName()
        let lower = shortName.lowercased()

        // Reject blacklisted names
        if usernameBlacklist.contains(lower) {
            return ""
        }

        // Reject all-numeric usernames
        if shortName.allSatisfy(\.isNumber) {
            return ""
        }

        // Accept if longer than 2 characters
        if shortName.count > 2 {
            return shortName
        }

        return ""
    }
}

import SwiftUI
import VellumAssistantShared

@MainActor
struct NameExchangeView: View {
    // MARK: - Configuration

    @Binding var userName: String
    @Binding var assistantName: String

    /// Stable subset of the name pool to display as quick-tap pills. The caller
    /// is responsible for sampling so the pills don't reshuffle across re-renders.
    let displayedAssistantNames: [String]

    var onBack: (() -> Void)?
    var onComplete: () -> Void
    var onSkip: () -> Void

    // MARK: - Private State

    @State private var showHeader = false
    @State private var showContent = false
    @State private var hoveredSuggestion: String?

    /// Curated pool of short, evocative names for the assistant. The quick-tap
    /// suggestion pills show a random sample of `suggestionCount` names drawn
    /// from this pool per onboarding session.
    static let assistantNamePool = [
        "Pax", "Atlas", "Sage", "Nova", "Kit",
        "Echo", "Luna", "Juno", "Ada", "Iris",
        "Milo", "Remy", "Wren", "Lark", "Vesper",
        "Onyx", "Vela", "Cleo", "Quill", "Rune",
        "Orion", "Ember", "Ziggy", "Bodhi", "Pip",
    ]

    /// Number of suggestion pills shown at a time.
    static let suggestionCount = 5

    /// Returns `suggestionCount` unique random names drawn from the pool.
    static func sampleAssistantNames() -> [String] {
        Array(assistantNamePool.shuffled().prefix(suggestionCount))
    }

    /// Usernames that are clearly not real names and should not be pre-filled.
    private static let usernameBlacklist: Set<String> = ["admin", "user", "root", "guest"]

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            // Header
            ZStack(alignment: .leading) {
                Text("Let's get to know each other.")
                    .font(VFont.titleLarge)
                    .foregroundStyle(VColor.contentDefault)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, VSpacing.xxl)

                if let onBack {
                    Button {
                        onBack()
                    } label: {
                        VIconView(.chevronLeft, size: 16)
                            .foregroundStyle(VColor.contentSecondary)
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                    .accessibilityLabel("Back")
                    .padding(.leading, VSpacing.xxl)
                }
            }
            .opacity(showHeader ? 1 : 0)
            .offset(y: showHeader ? 0 : 8)
            .padding(.bottom, VSpacing.xxl)

            // Form content
            VStack(spacing: VSpacing.lg) {
                // "I'll call you..." field
                VTextField(
                    "What's your name?",
                    placeholder: "Your name",
                    text: $userName
                )

                // "Call me..." field + suggestion pills
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    VTextField(
                        "What should I go by?",
                        placeholder: "Assistant name",
                        text: $assistantName
                    )

                    // Suggestion pills
                    HStack(spacing: VSpacing.xs) {
                        ForEach(displayedAssistantNames, id: \.self) { suggestion in
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
        let isActive = assistantName == name
        return Button {
            assistantName = name
        } label: {
            Text(name)
                .font(VFont.labelDefault)
                .foregroundStyle(isActive ? VColor.contentInset : VColor.contentSecondary)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xs)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.pill)
                        .fill(isActive ? VColor.primaryBase : (hoveredSuggestion == name ? VColor.surfaceBase : VColor.surfaceLift))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.pill)
                                .stroke(isActive ? VColor.primaryBase : VColor.borderElement, lineWidth: 1)
                        )
                )
        }
        .buttonStyle(.plain)
        .pointerCursor(onHover: { hovering in
            withAnimation(VAnimation.fast) {
                hoveredSuggestion = hovering ? name : nil
            }
        })
        .accessibilityLabel(name)
        .accessibilityValue(isActive ? "Selected" : "Not selected")
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    // MARK: - Helpers

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

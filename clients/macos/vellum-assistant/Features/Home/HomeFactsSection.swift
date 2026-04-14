import SwiftUI
import VellumAssistantShared

/// "What I Know About You" — the facts panel on the Home page.
///
/// Reads like a small editorial spread: a refined header sets the tone, then
/// three category groups (voice / world / priorities) each lead with a
/// colored bullet so the reader can scan by category without having to parse
/// chip colors. Empty sub-groups disappear entirely so the panel never shows
/// stub headers without content.
///
/// Special states:
/// - **Empty** (`facts.isEmpty`): icon + the exact TDD copy
///   "We just met — I'll learn more as we work together".
/// - **Onboarding-only nudge**: when every fact is still onboarding-sourced,
///   a gentle nudge line is shown beneath the sub-groups encouraging the
///   user to keep chatting. Forward-compat with Phase 4.
struct HomeFactsSection: View {
    let facts: [Fact]

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            sectionHeader

            if facts.isEmpty {
                emptyState
                    .transition(.opacity)
            } else {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    ForEach(Self.orderedCategories, id: \.self) { category in
                        let groupFacts = facts.filter { $0.category == category }
                        if !groupFacts.isEmpty {
                            categoryGroup(category: category, facts: groupFacts)
                        }
                    }

                    if showsOnboardingNudge {
                        Text("Start chatting and I'll pick up a lot more")
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentTertiary)
                            .padding(.top, VSpacing.xs)
                    }
                }
                .transition(.opacity)
            }
        }
        .animation(VAnimation.standard, value: facts)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("What I know about you"))
    }

    // MARK: - Section header

    private var sectionHeader: some View {
        HStack(alignment: .firstTextBaseline, spacing: VSpacing.sm) {
            Text("What I Know About You")
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentEmphasized)
                .accessibilityAddTraits(.isHeader)

            Spacer(minLength: 0)

            if !facts.isEmpty {
                Text("\(facts.count) \(facts.count == 1 ? "fact" : "facts")")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    // MARK: - Empty state

    private var emptyState: some View {
        HStack(alignment: .center, spacing: VSpacing.sm) {
            VIconView(.sparkles, size: 16)
                .foregroundStyle(VColor.contentTertiary)
            Text("We just met — I'll learn more as we work together")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Category group

    private func categoryGroup(category: Fact.Category, facts: [Fact]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.xs) {
                Circle()
                    .fill(Self.bulletColor(for: category))
                    .frame(width: 6, height: 6)
                Text(Self.subHeader(for: category))
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentSecondary)
                    .accessibilityAddTraits(.isHeader)
            }

            FlowLayout(spacing: VSpacing.sm) {
                ForEach(facts) { fact in
                    FactChipView(fact: fact)
                }
            }
        }
    }

    // MARK: - Static helpers

    /// Render order for the sub-groups. Tests + acceptance criteria both
    /// assert voice → world → priorities; keep this list authoritative.
    private static let orderedCategories: [Fact.Category] = [.voice, .world, .priorities]

    private static func subHeader(for category: Fact.Category) -> String {
        switch category {
        case .voice:      return "Your voice"
        case .world:      return "Your world"
        case .priorities: return "Your priorities"
        }
    }

    private static func bulletColor(for category: Fact.Category) -> Color {
        switch category {
        case .voice:      return VColor.funPurple
        case .world:      return VColor.funBlue
        case .priorities: return VColor.systemMidStrong
        }
    }

    /// Show the nudge only when there is at least one fact and every fact is
    /// still from onboarding — i.e. nothing has been inferred from actual
    /// conversations yet.
    private var showsOnboardingNudge: Bool {
        !facts.isEmpty && facts.allSatisfy { $0.source == .onboarding }
    }
}

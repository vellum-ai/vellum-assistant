import SwiftUI
import VellumAssistantShared

/// "What I Know About You" — the facts panel on the Home page.
///
/// Renders the user's `Fact`s grouped into three category sub-sections
/// (voice / world / priorities, in that order). Empty sub-groups are
/// hidden entirely rather than rendered as empty containers.
///
/// Special states:
/// - **Empty** (`facts.isEmpty`): shows a small glyph and the copy
///   "We just met — I'll learn more as we work together".
/// - **Onboarding-only nudge**: when every fact is still
///   `.onboarding`-sourced, a gentle nudge line is shown beneath the
///   sub-groups encouraging the user to keep chatting. In Phase 3 all
///   facts are inferred, so this branch is forward-compat for Phase 4.
///
/// Changes to `facts` fade in/out via `VAnimation.standard`.
struct HomeFactsSection: View {
    let facts: [Fact]

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("What I Know About You")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)

            if facts.isEmpty {
                emptyState
                    .transition(.opacity)
            } else {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    ForEach(Self.orderedCategories, id: \.self) { category in
                        let groupFacts = facts.filter { $0.category == category }
                        if !groupFacts.isEmpty {
                            categoryGroup(category: category, facts: groupFacts)
                        }
                    }

                    if showsOnboardingNudge {
                        Text("Start chatting and I'll pick up a lot more")
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentSecondary)
                    }
                }
                .transition(.opacity)
            }
        }
        .animation(VAnimation.standard, value: facts)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("What I know about you"))
    }

    // MARK: - Sub-views

    private var emptyState: some View {
        HStack(alignment: .center, spacing: VSpacing.sm) {
            VIconView(.sparkles, size: 16)
                .foregroundStyle(VColor.contentSecondary)
            Text("We just met — I'll learn more as we work together")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func categoryGroup(category: Fact.Category, facts: [Fact]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text(Self.subHeader(for: category))
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentSecondary)

            FlowLayout(spacing: 8) {
                ForEach(facts) { fact in
                    FactChipView(fact: fact)
                }
            }
        }
    }

    // MARK: - Helpers

    /// Render order for the sub-groups. Keep this list authoritative —
    /// tests and the acceptance criteria both assert voice → world → priorities.
    private static let orderedCategories: [Fact.Category] = [.voice, .world, .priorities]

    private static func subHeader(for category: Fact.Category) -> String {
        switch category {
        case .voice:      return "Your voice"
        case .world:      return "Your world"
        case .priorities: return "Your priorities"
        }
    }

    /// Show the nudge only when there is at least one fact and every
    /// fact is still from onboarding — i.e. nothing has been inferred
    /// from actual conversations yet.
    private var showsOnboardingNudge: Bool {
        !facts.isEmpty && facts.allSatisfy { $0.source == .onboarding }
    }
}

import SwiftUI
import VellumAssistantShared

/// The "What I Can Do" section on the Home page.
///
/// Renders a section header with an `unlocked/total` counter on the right,
/// followed by a vertical stack of `CapabilityRowView`s ordered by tier
/// (`.unlocked` → `.nextUp` → `.earned`). The ordering uses a stable sort
/// so capabilities within the same tier preserve the input order (Swift's
/// standard `sorted(by:)` is not stable, so we sort an enumerated sequence
/// and break ties on the original offset).
///
/// Per the Home TDD's "no table-stakes capabilities" rule, this view renders
/// exactly the rows it is given — it never injects placeholder "basic chat"
/// rows. An empty `capabilities` array produces an empty section body.
///
/// CTA closures bubble straight through to each underlying row so the parent
/// view owns all navigation decisions.
struct HomeCapabilitiesSection: View {
    let capabilities: [Capability]
    let onPrimaryCTA: (Capability) -> Void
    let onShortcutCTA: (Capability) -> Void

    private var unlockedCount: Int {
        capabilities.filter { $0.tier == .unlocked }.count
    }

    /// Stable sort by tier bucket. Within the same tier the input order is
    /// preserved by breaking ties on the enumerated offset.
    private var orderedCapabilities: [Capability] {
        capabilities
            .enumerated()
            .sorted { lhs, rhs in
                let lo = tierOrder(lhs.element.tier)
                let ro = tierOrder(rhs.element.tier)
                return lo == ro ? lhs.offset < rhs.offset : lo < ro
            }
            .map(\.element)
    }

    private func tierOrder(_ tier: Capability.Tier) -> Int {
        switch tier {
        case .unlocked: return 0
        case .nextUp:   return 1
        case .earned:   return 2
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack(alignment: .firstTextBaseline, spacing: VSpacing.sm) {
                Text("What I Can Do")
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentEmphasized)

                Spacer(minLength: 0)

                Text("\(unlockedCount)/\(capabilities.count) unlocked")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(orderedCapabilities) { capability in
                    CapabilityRowView(
                        capability: capability,
                        onPrimaryCTA: onPrimaryCTA,
                        onShortcutCTA: onShortcutCTA
                    )
                }
            }
        }
    }
}

import SwiftUI
import VellumAssistantShared

/// A single capability row on the Home page.
///
/// Renders one of three visually distinct treatments based on
/// `Capability.tier`:
///
/// - `.unlocked` — compact green-check row, full opacity. The capability is
///   live and ready to use.
/// - `.nextUp`   — green-tinted card with a subtle border and a pulsing dot
///   icon, plus a prominent primary CTA driven by `capability.ctaLabel`.
/// - `.earned`   — muted (55% opacity) row with a dashed icon border, the
///   honest `unlockHint` copy from the model, and a low-emphasis
///   "Want to get started?" shortcut.
///
/// CTAs are closure-driven so the parent view owns navigation:
///
/// ```swift
/// CapabilityRowView(
///     capability: cap,
///     onPrimaryCTA: { handleConnect($0) },
///     onShortcutCTA: { handleEarnedShortcut($0) }
/// )
/// ```
///
/// Both `ctaLabel` and `unlockHint` come straight from the shared
/// `Capability` model — never hardcode them here.
struct CapabilityRowView: View {
    let capability: Capability
    let onPrimaryCTA: (Capability) -> Void
    let onShortcutCTA: (Capability) -> Void

    var body: some View {
        switch capability.tier {
        case .unlocked:
            unlockedRow
        case .nextUp:
            nextUpCard
        case .earned:
            earnedRow
        }
    }

    // MARK: - Unlocked

    private var unlockedRow: some View {
        HStack(alignment: .center, spacing: VSpacing.md) {
            ZStack {
                Circle()
                    .fill(VColor.systemPositiveWeak)
                VIconView(.check, size: 12)
                    .foregroundStyle(VColor.systemPositiveStrong)
            }
            .frame(width: 24, height: 24)

            Text(capability.name)
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)

            Spacer(minLength: 0)
        }
        .padding(.vertical, VSpacing.xs)
    }

    // MARK: - Next-up

    private var nextUpCard: some View {
        HStack(alignment: .top, spacing: VSpacing.md) {
            PulsingDotIcon()
                .frame(width: 24, height: 24)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(capability.name)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentEmphasized)

                Text(capability.description)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                if let ctaLabel = capability.ctaLabel {
                    VButton(
                        label: ctaLabel,
                        style: .primary,
                        size: .compact
                    ) {
                        onPrimaryCTA(capability)
                    }
                    .padding(.top, VSpacing.xs)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(VColor.systemPositiveWeak)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(VColor.systemPositiveStrong.opacity(0.25), lineWidth: 1)
        )
    }

    // MARK: - Earned

    private var earnedRow: some View {
        HStack(alignment: .top, spacing: VSpacing.md) {
            ZStack {
                Circle()
                    .strokeBorder(
                        VColor.contentTertiary,
                        style: StrokeStyle(lineWidth: 1, dash: [3, 2])
                    )
                VIconView(.lock, size: 11)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .frame(width: 24, height: 24)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(capability.name)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentDefault)

                if let unlockHint = capability.unlockHint {
                    Text(unlockHint)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VButton(
                    label: "Want to get started?",
                    style: .ghost,
                    size: .compact
                ) {
                    onShortcutCTA(capability)
                }
                .padding(.top, VSpacing.xxs)
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, VSpacing.xs)
        .opacity(0.55)
    }
}

// MARK: - Pulsing Dot

/// A small filled dot that gently pulses via opacity. Uses a single SwiftUI
/// implicit animation so it does not peg CPU — the system batches the
/// interpolation with the display refresh rather than driving it from a
/// timer.
private struct PulsingDotIcon: View {
    @State private var pulsing = false

    var body: some View {
        ZStack {
            Circle()
                .fill(VColor.systemPositiveStrong.opacity(0.18))
            Circle()
                .fill(VColor.systemPositiveStrong)
                .frame(width: 10, height: 10)
                .opacity(pulsing ? 0.4 : 1.0)
                .animation(
                    .easeInOut(duration: 1.1).repeatForever(autoreverses: true),
                    value: pulsing
                )
        }
        .onAppear { pulsing = true }
    }
}

// MARK: - Preview

#Preview("CapabilityRowView — Light") {
    CapabilityRowPreviewStack()
        .padding(VSpacing.lg)
        .frame(width: 360)
        .background(VColor.surfaceBase)
        .preferredColorScheme(.light)
}

#Preview("CapabilityRowView — Dark") {
    CapabilityRowPreviewStack()
        .padding(VSpacing.lg)
        .frame(width: 360)
        .background(VColor.surfaceBase)
        .preferredColorScheme(.dark)
}

private struct CapabilityRowPreviewStack: View {
    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            CapabilityRowView(
                capability: Capability(
                    id: "voice-onboarding",
                    name: "Knows your voice",
                    description: "I write the way you write.",
                    tier: .unlocked,
                    gate: "Complete onboarding",
                    unlockHint: nil,
                    ctaLabel: nil
                ),
                onPrimaryCTA: { _ in },
                onShortcutCTA: { _ in }
            )

            CapabilityRowView(
                capability: Capability(
                    id: "google-connect",
                    name: "Read your calendar",
                    description: "Check what's on your plate before suggesting times.",
                    tier: .nextUp,
                    gate: "Connect Google",
                    unlockHint: nil,
                    ctaLabel: "Connect Google →"
                ),
                onPrimaryCTA: { _ in },
                onShortcutCTA: { _ in }
            )

            CapabilityRowView(
                capability: Capability(
                    id: "draft-emails",
                    name: "Draft emails for you",
                    description: "Reply in your tone, with the context I've built up.",
                    tier: .earned,
                    gate: "10+ conversations and a connected inbox",
                    unlockHint: "I need to see how you actually write — that takes a few real conversations.",
                    ctaLabel: nil
                ),
                onPrimaryCTA: { _ in },
                onShortcutCTA: { _ in }
            )
        }
    }
}

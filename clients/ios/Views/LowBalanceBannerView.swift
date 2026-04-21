#if canImport(UIKit)
import SafariServices
import SwiftUI
import UIKit
import VellumAssistantShared

// MARK: - Balance Classification

/// How we display the current credit balance in the low-balance banner.
///
/// Mirrors the macOS `DrawerMenuView` thresholds so the two platforms agree
/// on what counts as "low" vs. "depleted":
/// - `.depleted` — `effective_balance <= 0`
/// - `.low`      — `0 < effective_balance < $1.00`
/// - `.ok`       — anything higher, or an unparseable value (fail-silent)
enum LowBalanceState: Equatable {
    case ok
    case low
    case depleted
}

/// Helpers for the iOS MVP low-balance banner (LUM-1004).
///
/// iOS does not ship an in-app purchase flow for MVP — when a user's
/// credit balance is low or depleted we surface a banner that redirects
/// them to the web billing page (`{platformURL}/billing`) in
/// `SFSafariViewController`. The web billing page handles top-up via
/// Stripe. See the PRD "Edge Case Decisions" section: "When a user's
/// balance drops, route them to a web URL to top up."
enum LowBalanceBanner {
    /// Below this (in credits, i.e. dollars) we surface the `.low` warning.
    /// Matches the macOS `DrawerMenuView.loadBalance` threshold.
    static let lowBalanceThreshold: Double = 1.0

    /// Classify a billing summary for display. Returns `.ok` when the balance
    /// string fails to parse — better to stay silent than to cry wolf on a
    /// malformed server response.
    static func state(for summary: BillingSummaryResponse) -> LowBalanceState {
        guard let value = Double(summary.effective_balance) else { return .ok }
        if value <= 0 { return .depleted }
        if value < lowBalanceThreshold { return .low }
        return .ok
    }

    /// Web billing page URL — destination of the iOS MVP top-up redirect.
    ///
    /// Resolves off `VellumEnvironment.resolvedPlatformURL` so local / dev /
    /// staging builds point at their matching platform host. Falls back to
    /// production if the resolved URL fails to parse (defensive; the
    /// resolver already validates its output).
    static var webBillingURL: URL {
        URL(string: "\(VellumEnvironment.resolvedPlatformURL)/billing")
            ?? URL(string: "https://platform.vellum.ai/billing")!
    }
}

// MARK: - SFSafariViewController wrapper

/// SwiftUI wrapper around `SFSafariViewController`. Used by the low-balance
/// banner to open the web billing page in-app.
///
/// Apple reference: [`SFSafariViewController`](https://developer.apple.com/documentation/safariservices/sfsafariviewcontroller).
/// Presenting in a `.sheet` is the Apple-sanctioned pattern for embedding it
/// inside a SwiftUI hierarchy — full-screen cover also works but hides the
/// close affordance on taller devices.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {
        // No-op: the URL is fixed at construction time. `SFSafariViewController`
        // does not expose a way to navigate to a new URL after presentation.
    }
}

// MARK: - Banner row

/// The visual banner chrome — a row that sits above the chat content,
/// matching the look-and-feel of `ConversationChatView.forkParentChrome`.
/// Separated from the host so snapshot / preview tests can render it against
/// synthetic state without driving `BillingService`.
struct LowBalanceBannerRow: View {
    let state: LowBalanceState
    let onTap: () -> Void
    let onDismiss: () -> Void

    private var title: String {
        switch state {
        case .depleted: return "You're out of credits"
        case .low:      return "Your credit balance is low"
        case .ok:       return ""
        }
    }

    private var subtitle: String {
        switch state {
        case .depleted: return "Top up on the web to keep chatting."
        case .low:      return "Top up on the web before you run out."
        case .ok:       return ""
        }
    }

    private var accentColor: Color {
        state == .depleted ? VColor.systemNegativeStrong : VColor.systemMidStrong
    }

    private var backgroundTint: Color {
        state == .depleted ? VColor.systemNegativeWeak : VColor.systemMidWeak
    }

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.triangleAlert, size: 14)
                .foregroundStyle(accentColor)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentEmphasized)
                Text(subtitle)
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(2)
            }

            Spacer(minLength: VSpacing.sm)

            Button(action: onTap) {
                Text("Top up")
                    .font(VFont.labelDefault)
                    .foregroundStyle(.white)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)
                    .background(accentColor)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            }
            .accessibilityLabel("Top up credits")
            .accessibilityHint("Opens the Vellum billing page in Safari")

            Button(action: onDismiss) {
                VIconView(.x, size: 14)
                    .foregroundStyle(VColor.contentTertiary)
                    .padding(VSpacing.xxs)
            }
            .accessibilityLabel("Dismiss low balance banner")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(backgroundTint)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(VColor.borderBase)
                .frame(height: 1)
                .accessibilityHidden(true)
        }
    }
}

// MARK: - Banner host

/// Self-contained host for the low-balance redirect banner.
///
/// Fetches the organization's billing summary via the shared `BillingService`
/// and, when the balance is `.low` or `.depleted`, renders the banner above
/// the chat content. Tapping "Top up" opens the web billing page in
/// `SFSafariViewController` — iOS MVP does not ship an in-app purchase flow.
///
/// ## Refresh cadence
/// - First appearance (`.task`)
/// - Returning from background (`UIApplication.willEnterForegroundNotification`),
///   which covers the Safari-app redirect path
/// - Safari sheet dismissal — the user may have just topped up
///
/// ## Dismissal
/// Session-scoped. If the user dismisses the banner at a given state, it
/// stays hidden for that exact state. Transitioning into a different state
/// (e.g. `.low` → `.depleted`) re-shows the banner, and recovering to `.ok`
/// clears the dismissal so a future drop re-surfaces it.
///
/// ## Failure behavior
/// `BillingService.getBillingSummary` throws when the user is unauthenticated
/// or no organization is connected. We swallow those errors silently — the
/// banner is a best-effort signal, not a blocking surface.
struct LowBalanceBannerHost: View {
    @State private var summary: BillingSummaryResponse?
    @State private var showSafari: Bool = false
    @State private var dismissedForState: LowBalanceState?

    private var state: LowBalanceState {
        guard let summary else { return .ok }
        return LowBalanceBanner.state(for: summary)
    }

    private var shouldShowBanner: Bool {
        state != .ok && dismissedForState != state
    }

    var body: some View {
        Group {
            if shouldShowBanner {
                LowBalanceBannerRow(
                    state: state,
                    onTap: { showSafari = true },
                    onDismiss: { dismissedForState = state }
                )
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: shouldShowBanner)
        .task {
            await refreshSummary()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            Task { await refreshSummary() }
        }
        .sheet(isPresented: $showSafari, onDismiss: {
            Task { await refreshSummary() }
        }) {
            SafariView(url: LowBalanceBanner.webBillingURL)
                .ignoresSafeArea()
        }
    }

    private func refreshSummary() async {
        do {
            let fresh = try await BillingService.shared.getBillingSummary()
            summary = fresh
            // Clear the session dismissal once the balance recovers so a
            // subsequent drop re-shows the banner.
            if LowBalanceBanner.state(for: fresh) == .ok {
                dismissedForState = nil
            }
        } catch {
            // Silent by design — see doc comment. A noisy banner on a
            // transient network blip or an unauthenticated session would be
            // worse than a missed warning.
        }
    }
}
#endif

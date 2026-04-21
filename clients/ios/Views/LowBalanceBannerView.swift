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

// MARK: - Session state

/// Holds the low-balance banner's dismissal state at process scope, so it
/// survives view recreation.
///
/// `LowBalanceBannerHost` is mounted inside `ConversationChatView`, which is
/// recreated per conversation selection on iPad's `NavigationSplitView`. If
/// `dismissedForState` lived in `@State` on the host, an iPad user who
/// dismissed the banner would see it re-appear the next time they tapped a
/// conversation in the sidebar. Lifting the state to an `@Observable`
/// singleton — observed by every host instance — makes dismissal truly
/// session-scoped on both iPhone and iPad.
@MainActor
@Observable
final class LowBalanceBannerSession {
    static let shared = LowBalanceBannerSession()

    /// The state at which the user dismissed the banner, if any. Set when
    /// the x button fires, cleared on recovery to `.ok` so a subsequent
    /// drop re-surfaces the banner.
    var dismissedForState: LowBalanceState?

    private init() {}
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
/// Session-scoped via `LowBalanceBannerSession.shared`, so the dismissal
/// survives view recreation (notably iPad's `NavigationSplitView` rebuilding
/// the detail pane on conversation switch). If the user dismisses the banner
/// at a given state it stays hidden for that state; transitioning into a
/// different state (e.g. `.low` → `.depleted`) re-shows the banner, and
/// recovering to `.ok` clears the dismissal so a future drop re-surfaces it.
///
/// ## Failure behavior
/// `BillingService.getBillingSummary` throws when the user is unauthenticated
/// or no organization is connected. We swallow those errors silently — but
/// we also clear any previously-fetched `summary`, so a stale `.low` or
/// `.depleted` banner doesn't persist (and falsely re-prompt for top-up)
/// after a transient refresh failure following an actual balance change.
struct LowBalanceBannerHost: View {
    @State private var summary: BillingSummaryResponse?
    @State private var showSafari: Bool = false
    /// Process-scoped dismissal lives on the singleton so it survives
    /// `ConversationChatView` recreation. Observed directly — the
    /// `@Observable` conformance on `LowBalanceBannerSession` triggers
    /// re-evaluation when `dismissedForState` changes.
    private let session = LowBalanceBannerSession.shared

    private var state: LowBalanceState {
        guard let summary else { return .ok }
        return LowBalanceBanner.state(for: summary)
    }

    private var shouldShowBanner: Bool {
        state != .ok && session.dismissedForState != state
    }

    var body: some View {
        Group {
            if shouldShowBanner {
                LowBalanceBannerRow(
                    state: state,
                    onTap: { showSafari = true },
                    onDismiss: { session.dismissedForState = state }
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
            // Mirror the macOS `DrawerMenuView.loadBalance` sequence: fetch
            // the current summary, then run the one-shot bootstrap if the
            // org's balances are all-zero. Without this step a brand-new
            // organization would be classified as `.depleted` before its
            // bootstrap credit is granted, prompting an unnecessary top-up.
            var fresh = try await BillingService.shared.getBillingSummary()
            if let bootstrapped = await BillingService.shared.bootstrapBillingSummaryIfNeeded(summary: fresh) {
                fresh = bootstrapped
            }
            summary = fresh
            // Clear the session dismissal once the balance recovers so a
            // subsequent drop re-shows the banner.
            if LowBalanceBanner.state(for: fresh) == .ok {
                session.dismissedForState = nil
            }
        } catch {
            // Drop any prior summary on failure. Keeping the previous value
            // would risk a stale `.low`/`.depleted` banner continuing to
            // prompt for top-up after a successful top-up if the refresh
            // call later failed (e.g. transient network blip on foreground
            // return). Hiding the banner until we have fresh data is
            // strictly safer than showing a false warning.
            summary = nil
        }
    }
}
#endif

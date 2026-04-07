import AppKit
import SwiftUI
import VellumAssistantShared

/// Modal that surfaces the referral program — how it works, invite link, stats, and terms.
/// Presented from the "Earn credits" row in the preferences drawer.
@MainActor
struct EarnCreditsModal: View {
    @Environment(\.dismiss) private var dismiss

    @State private var referralCode: ReferralCodeResponse?
    @State private var isLoading: Bool = true
    @State private var error: String?
    @State private var copied: Bool = false
    @State private var copyResetTask: Task<Void, Never>?
    @State private var showTerms: Bool = false

    private var subtitleText: String {
        guard let code = referralCode else {
            return "Refer friends to earn free credits."
        }
        let cap = formatCredits(code.earning_cap)
        let referrerAmount = formatCredits(code.referrer_credit_amount)
        let refereeAmount = formatCredits(code.credit_amount)
        if referrerAmount == refereeAmount {
            return "Share Vellum with friends — you'll each earn \(referrerAmount) credits when they sign up, up to \(cap) total."
        } else {
            return "Share Vellum with friends — you'll earn \(referrerAmount) credits and they'll get \(refereeAmount) when they sign up, up to \(cap) total."
        }
    }

    /// Strip trailing `.00` from a decimal-string credit amount so that whole
    /// numbers render as `5` instead of `5.00`.
    private func formatCredits(_ amount: String) -> String {
        amount.replacingOccurrences(of: ".00", with: "")
    }

    var body: some View {
        VModal(
            title: showTerms ? "" : "Earn free credits",
            subtitle: showTerms ? nil : subtitleText,
            closeAction: { dismiss() },
            backAction: showTerms ? { withAnimation { showTerms = false } } : nil
        ) {
            if showTerms, let referralCode {
                termsContent(referralCode)
            } else if isLoading {
                loadingContent
            } else if let error {
                errorContent(error)
            } else if let referralCode {
                mainContent(referralCode)
            }
        }
        .frame(width: 420)
        .task {
            await loadReferralCode()
        }
    }

    // MARK: - Main Content

    private func mainContent(_ code: ReferralCodeResponse) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            howItWorks(code)
            SettingsDivider()
            referralLinkRow(code)
            SettingsDivider()
            statsRow(code)
            SettingsDivider()
            termsLink
        }
        .padding(.bottom, VSpacing.lg)
    }

    // MARK: - How It Works

    private func howItWorks(_ code: ReferralCodeResponse) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            howItWorksStep(icon: .share, title: "Share your invite link")
            howItWorksStep(icon: .users, title: "They sign up")
            howItWorksStep(icon: .gift, title: "You earn credits")
        }
    }

    private func howItWorksStep(icon: VIcon, title: String) -> some View {
        HStack(spacing: VSpacing.md) {
            VIconView(icon, size: 14)
                .foregroundStyle(VColor.primaryBase)
                .frame(width: 28, height: 28)
                .background(VColor.primaryBase.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))

            Text(title)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
        }
    }

    // MARK: - Referral Link

    private func referralLinkRow(_ code: ReferralCodeResponse) -> some View {
        HStack(spacing: VSpacing.sm) {
            Text(code.referral_url)
                .font(.custom("DMMono-Regular", size: 13))
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.sm)
                .background(VColor.surfaceBase)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.borderBase, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

            VButton(
                label: copied ? "Copied" : "Copy referral link",
                iconOnly: copied ? VIcon.check.rawValue : VIcon.copy.rawValue,
                style: .primary
            ) {
                copyToClipboard(code.referral_url)
            }
        }
    }

    // MARK: - Stats

    private func statsRow(_ code: ReferralCodeResponse) -> some View {
        let earnedFormatted = code.total_earned.replacingOccurrences(of: ".00", with: "")
        return HStack(spacing: VSpacing.md) {
            statItem(icon: .users, value: "\(code.referred_count)", label: "Friends Referred")
                .frame(maxWidth: .infinity, alignment: .leading)
            statItem(icon: .creditCard, value: earnedFormatted, label: "Credits Earned")
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func statItem(icon: VIcon, value: String, label: String) -> some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(icon, size: 12)
                .foregroundStyle(VColor.contentSecondary)
            (Text(value)
                .foregroundStyle(VColor.contentEmphasized)
            + Text(" \(label)")
                .foregroundStyle(VColor.contentSecondary))
            .font(VFont.bodySmallDefault)
        }
    }

    // MARK: - Terms Link

    private var termsLink: some View {
        Button {
            withAnimation { showTerms = true }
        } label: {
            Text("View Terms and Conditions")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity, alignment: .center)
    }

    // MARK: - Terms Content

    private func termsContent(_ code: ReferralCodeResponse) -> some View {
        let cap = formatCredits(code.earning_cap)
        return VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text("Referral Program Terms")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)

            VStack(alignment: .leading, spacing: VSpacing.md) {
                termsBullet("This promotion is available to new users who sign up through your referral link only.")
                termsBullet("Rewards are earned once your invitee completes the creation of their Vellum account.")
                termsBullet("You may earn up to \(cap) free credits through the Referral Program. We may change this limit at any time.")
                termsBullet("We do not grant credits for disposable or high-risk email accounts.")
                termsBullet("Each new user can generate only one (1) reward. No stacking or loophole hunting.")
                termsBullet("Please avoid spamming or misusing your referral link. Our systems actively monitor referral engagement.")
                termsBullet("If we detect suspicious or non-compliant activity, we reserve the right to withhold rewards or deactivate your referral link.")
                termsBullet("We may update, pause, or discontinue this program at any time.")
            }
        }
        .padding(.bottom, VSpacing.lg)
    }

    private func termsBullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            Text("\u{2022}")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)
            Text(text)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)
        }
    }

    // MARK: - Loading

    /// Skeleton placeholder that mirrors `mainContent` section-for-section so
    /// the modal layout doesn't jump when the API responds.
    private var loadingContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // How it works steps
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                howItWorksStepSkeleton(textWidth: 140)
                howItWorksStepSkeleton(textWidth: 100)
                howItWorksStepSkeleton(textWidth: 130)
            }

            SettingsDivider()

            // Referral link row — full-width URL field + icon-only copy button
            HStack(spacing: VSpacing.sm) {
                VSkeletonBone(height: 32, radius: VRadius.md)
                VSkeletonBone(width: 32, height: 32, radius: VRadius.md)
            }

            SettingsDivider()

            // Stats row — two equal-width inline stat items
            HStack(spacing: VSpacing.md) {
                statItemSkeleton()
                    .frame(maxWidth: .infinity, alignment: .leading)
                statItemSkeleton()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            SettingsDivider()

            // Terms link — small centered text
            VSkeletonBone(width: 150, height: 12)
                .frame(maxWidth: .infinity, alignment: .center)
        }
        .padding(.bottom, VSpacing.lg)
        .accessibilityHidden(true)
    }

    private func howItWorksStepSkeleton(textWidth: CGFloat) -> some View {
        HStack(spacing: VSpacing.md) {
            VSkeletonBone(width: 28, height: 28, radius: VRadius.sm)
            VSkeletonBone(width: textWidth, height: 14)
        }
    }

    private func statItemSkeleton() -> some View {
        HStack(spacing: VSpacing.xs) {
            VSkeletonBone(width: 12, height: 12)
            VSkeletonBone(width: 100, height: 12)
        }
    }

    // MARK: - Error

    private func errorContent(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack(spacing: VSpacing.sm) {
                VIconView(.circleAlert, size: 14)
                    .foregroundStyle(VColor.systemNegativeStrong)
                Text(message)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
            VButton(label: "Try Again", style: .outlined) {
                Task { await loadReferralCode() }
            }
        }
        .padding(.bottom, VSpacing.lg)
    }

    // MARK: - Actions

    private func loadReferralCode() async {
        if referralCode == nil {
            isLoading = true
        }
        error = nil
        do {
            referralCode = try await BillingService.shared.getReferralCode()
        } catch {
            if referralCode == nil {
                self.error = "Failed to load referral information."
            }
        }
        isLoading = false
    }

    private func copyToClipboard(_ url: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url, forType: .string)
        copied = true
        copyResetTask?.cancel()
        copyResetTask = Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled else { return }
            copied = false
        }
    }
}

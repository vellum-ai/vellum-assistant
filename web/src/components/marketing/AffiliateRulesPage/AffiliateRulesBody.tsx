import { FullNavBar } from "@/components/marketing/CommunityPage/_FullNavBar";
import { WorkflowCTA } from "@/components/marketing/VellumHomepage/WorkflowCTA";

export function AffiliateRulesBody() {
  return (
    <>
      <FullNavBar />
      <main className="main-wrapper">
        <div className="section_docs">
          <div className="padding-global">
            <div className="container-new docs">
              <div className="padding-section-medium">
                <div className="docs-content">
                  <h1 className="heading-1-new text-color-white font-playfair">
                    Affiliate program rules
                  </h1>
                  <p className="u-text-regular text-color-light-gray">
                    Learn how Vellum affiliates earn 30% commission by helping others build with AI.
                  </p>
                  <p className="u-text-regular text-color-light-gray">
                    Welcome to the Vellum Affiliate Program. These terms explain how commissions work, how referrals are tracked, and how payouts happen. By joining or sharing your unique link, you agree to everything outlined below.
                  </p>

                  <h2 className="heading-2-new text-color-white">How It Works</h2>
                  <p className="u-text-regular text-color-light-gray">
                    Each affiliate gets a unique referral link containing a <code>utm_content</code> code (for example you&apos;ll be given a link that looks like this:
                  </p>
                  <p className="u-text-regular text-color-light-gray">
                    <code>https://tryvellum.ai/s/&#123;code&#125;</code>
                  </p>
                  <p className="u-text-regular text-color-light-gray">
                    This URL will then convert to:
                  </p>
                  <p className="u-text-regular text-color-light-gray">
                    <code>https://vellum.ai?utm_source=&#123;source&#125;&amp;utm_medium=aff&amp;utm_content=YOURCODE</code>
                  </p>
                  <p className="u-text-regular text-color-light-gray">
                    That <code>utm_content</code> code identifies your referrals. We track every lead in HubSpot and tie conversions back to that code.
                  </p>

                  <h2 className="heading-2-new text-color-white">Commission</h2>
                  <p className="u-text-regular text-color-light-gray">
                    You earn <strong>30% commission</strong> on every new customer you bring who upgrades to a paid Vellum plan.
                  </p>
                  <ul className="docs-list">
                    <li>The commission applies to the <strong>first payment</strong> only, unless otherwise stated in writing.</li>
                    <li>Refunds, chargebacks, or canceled payments don&apos;t qualify.</li>
                    <li>Self-referrals or fake signups are not allowed.</li>
                    <li>Enterprise or custom invoiced deals are excluded unless pre-approved.</li>
                  </ul>

                  <h2 className="heading-2-new text-color-white">Attribution Window</h2>
                  <p className="u-text-regular text-color-light-gray">
                    When someone signs up through your link and becomes a paying user within <strong>30 days</strong>, the sale is credited to you. If multiple affiliates refer the same user, the <strong>last valid link</strong> used before signup is the one that counts.
                  </p>

                  <h2 className="heading-2-new text-color-white">Payouts</h2>
                  <ul className="docs-list">
                    <li>Commissions are paid <strong>monthly</strong>, <strong>30 days after the end of each month</strong> to allow for refunds and verification.</li>
                    <li>There&apos;s a <strong>$50 minimum payout threshold</strong>.</li>
                    <li>Payouts are sent via <strong>PayPal, Stripe, or bank transfer</strong>.</li>
                    <li>If a refund or chargeback happens after a payout, that amount will be adjusted in the next cycle.</li>
                  </ul>

                  <h2 className="heading-2-new text-color-white">Brand Use</h2>
                  <p className="u-text-regular text-color-light-gray">
                    You&apos;re welcome to use Vellum&apos;s name, logos, screenshots, and public assets in your content. Just:
                  </p>
                  <ul className="docs-list">
                    <li>Don&apos;t run paid ads that bid on &quot;Vellum&quot; or impersonate our team.</li>
                    <li>Don&apos;t make false or misleading claims about our product or pricing.</li>
                    <li>If you&apos;re unsure about a campaign, just ask first — we&apos;re happy to review it.</li>
                  </ul>

                  <h2 className="heading-2-new text-color-white">Dashboard &amp; Reporting</h2>
                  <p className="u-text-regular text-color-light-gray">
                    You can always reach out to <a href="mailto:anita@vellum.ai"><strong>anita@vellum.ai</strong></a> to confirm your current stats or payout status. We&apos;re working on an affiliate dashboard to make this fully self-serve.
                  </p>

                  <h2 className="heading-2-new text-color-white">Fraud &amp; Misuse</h2>
                  <p className="u-text-regular text-color-light-gray">
                    We reserve the right to withhold or reverse commissions for any activity that looks fraudulent — fake signups, coupon sites, self-referrals, or misleading promotions.
                  </p>

                  <h2 className="heading-2-new text-color-white">Termination</h2>
                  <p className="u-text-regular text-color-light-gray">
                    Either party can end participation in the program at any time. We&apos;ll still pay verified, eligible commissions that were earned before the end date.
                  </p>

                  <h2 className="heading-2-new text-color-white">Updates</h2>
                  <p className="u-text-regular text-color-light-gray">
                    We may occasionally update these terms. When that happens, we&apos;ll post the new version here. Continuing to share your affiliate link means you accept the latest version.
                  </p>
                  <p className="u-text-small text-color-gray">
                    <strong>Last updated:</strong> November 3, 2025
                  </p>
                  <p className="u-text-regular text-color-light-gray">
                    By participating in the Vellum Affiliate Program, you agree to the terms above.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
      <WorkflowCTA />
    </>
  );
}

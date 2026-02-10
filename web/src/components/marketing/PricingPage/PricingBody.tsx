import { PricingB2B } from "./_PricingB2B";
import { PricingCards } from "./_PricingCards";
import { PricingCompare } from "./_PricingCompare";
import { PricingEnterprise } from "./_PricingEnterprise";
import { PricingFAQ } from "./_PricingFAQ";
import { PricingFeatures } from "./_PricingFeatures";
import { PricingHeader } from "./_PricingHeader";
import { PricingNavbar } from "./_PricingNavbar";
import { PricingStyles } from "./_PricingStyles";
import { WorkflowCTA } from "../VellumHomepage/WorkflowCTA";

export function PricingBody() {
  return (
    <>
      <PricingStyles />
      <div className="page_wrap">
        <PricingNavbar />
        <div className="pricing_wrapper">
          <div className="u-container is--pricing">
            <PricingHeader />
            <PricingCards />
            <PricingCompare />
            <PricingFeatures />
            <PricingEnterprise />
            <PricingFAQ />
            <PricingB2B />
          </div>
        </div>
        <WorkflowCTA />
      </div>
    </>
  );
}

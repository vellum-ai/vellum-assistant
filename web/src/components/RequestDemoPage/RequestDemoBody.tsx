import { FullNavBar } from "@/components/CommunityPage/_FullNavBar";
import { WorkflowCTA } from "@/components/VellumHomepage/WorkflowCTA";

const CHECK_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const BENEFITS = [
  "Get a live walkthrough of the Vellum platform",
  "Explore use cases for your team",
  "Get advice on LLM architecture and prompts",
];

const PLATFORM_FEATURES = [
  {
    title: "Playground",
    description: "Compare your prompts side by side across OpenAI, Anthropic and open source models like Falcon-40b and Llama-2",
  },
  {
    title: "Deployments",
    description: "Monitor your production traffic and version control changes. Update your production prompts without redeploying your code",
  },
  {
    title: "Search",
    description: "Dynamically include company-specific context in your prompts without managing your own semantic search infra",
  },
  {
    title: "Workflows",
    description: "Combine prompts, search and business logic to build more advanced LLM applications",
  },
  {
    title: "Test Suites",
    description: "Evaluate the quality of your prompts across a large bank of test cases — uploaded via CSV, UI or API",
  },
  {
    title: "Fine-tuning",
    description: "Train state of the art open source models using your proprietary data to get lower cost, lower latency & higher accuracy",
  },
];

export function RequestDemoBody() {
  return (
    <>
      <FullNavBar />
      <main className="main-wrapper">
        <div className="section_docs">
          <div className="padding-global">
            <div className="container-new docs">
              <div className="padding-section-medium">
                <div className="demo-header">
                  <h1 className="heading-1-new text-color-white font-playfair">
                    Schedule a time with the Vellum team
                  </h1>
                  <p className="u-text-regular text-color-light-gray">
                    Explore use cases and the best pricing plan for your team
                  </p>
                </div>

                <div className="demo-benefits">
                  {BENEFITS.map((benefit) => (
                    <div key={benefit} className="demo-benefit-item">
                      <div className="demo-check-icon">{CHECK_ICON}</div>
                      <span className="u-text-regular text-color-light-gray">{benefit}</span>
                    </div>
                  ))}
                </div>

                <div className="demo-cta-section">
                  <h2 className="heading-2-new text-color-white">
                    Request a Personalized Demo
                  </h2>
                  <p className="u-text-regular text-color-light-gray">
                    Learn how hundreds of companies are building LLM-powered features faster using Vellum — begin your evaluation with a personalized demo from Vellum&apos;s founding team.
                  </p>
                  <a
                    href="https://www.vellum.ai/landing-pages/request-demo"
                    target="_blank"
                    rel="noreferrer"
                    className="d-button nav-button-5 cta-get-started new large w-inline-block"
                  >
                    <div className="btn-text nav-button-6 new">Request Demo</div>
                    <div className="d-button_bg-overlay nav-button-8" />
                  </a>
                </div>

                <div className="demo-testimonial">
                  <blockquote className="u-text-regular text-color-light-gray">
                    &quot;Vellum has completely transformed our company&apos;s LLM development process. We&apos;ve seen at least a 5x improvement in productivity while building AI powered features&quot;
                  </blockquote>
                  <p className="u-text-small text-color-gray">
                    <strong>Eric Lee, Partner &amp; CTO of Left Field Labs</strong>
                  </p>
                </div>

                <h2 className="heading-2-new text-color-white">
                  Get an insider&apos;s view to the entire platform
                </h2>
                <div className="demo-features-grid">
                  {PLATFORM_FEATURES.map((feature) => (
                    <div key={feature.title} className="demo-feature-card">
                      <h3 className="demo-feature-title">{feature.title}</h3>
                      <p className="u-text-small text-color-light-gray">{feature.description}</p>
                    </div>
                  ))}
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

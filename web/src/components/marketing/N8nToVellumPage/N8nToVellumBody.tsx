import { FullNavBar } from "@/components/marketing/CommunityPage/_FullNavBar";
import { WorkflowCTA } from "@/components/marketing/VellumHomepage/WorkflowCTA";

const FEATURES = [
  {
    title: "Build any agent you want, without the setup hassle",
    description: "Vellum recreates your workflow as an agent, adds integrations, and helps you publish in minutes.",
  },
  {
    title: "View exactly what the agent saw, said, and why it failed",
    description: "Full observability into every step of your agent's execution.",
  },
  {
    title: "Run your agents as much as you need without surprise charges",
    description: "$0 runtime fees",
  },
];

export function N8nToVellumBody() {
  return (
    <>
      <FullNavBar />
      <main className="main-wrapper">
        <div className="section_docs">
          <div className="padding-global">
            <div className="container-new docs">
              <div className="padding-section-medium">
                <div className="n8n-header">
                  <h1 className="heading-1-new text-color-white font-playfair">
                    Convert n8n workflows into Vellum agents
                  </h1>
                  <p className="u-text-regular text-color-light-gray">
                    Vellum recreates your workflow as an agent, adds integrations, and helps you publish in minutes.
                  </p>
                </div>

                <div className="n8n-cta-section">
                  <a
                    href="https://www.vellum.ai/n8n-to-vellum"
                    target="_blank"
                    rel="noreferrer"
                    className="d-button nav-button-5 cta-get-started new large w-inline-block"
                  >
                    <div className="btn-text nav-button-6 new">Convert your n8n workflow</div>
                    <div className="d-button_bg-overlay nav-button-8" />
                  </a>
                </div>

                <div className="n8n-chat-example">
                  <div className="n8n-chat-bubble n8n-user">
                    Hey Vellum, recreate this n8n workflow and hook it up to Slack so I get a message when it&apos;s finished.
                  </div>
                  <div className="n8n-chat-bubble n8n-assistant">
                    Great idea, converting and improving now...
                  </div>
                </div>

                <h2 className="heading-2-new text-color-white">
                  Stop configuring, start vibing.
                </h2>

                <h2 className="heading-2-new text-color-white">
                  Why Vellum feels easier than n8n
                </h2>
                <div className="n8n-features-grid">
                  {FEATURES.map((feature) => (
                    <div key={feature.title} className="n8n-feature-card">
                      <h3 className="n8n-feature-title">{feature.title}</h3>
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

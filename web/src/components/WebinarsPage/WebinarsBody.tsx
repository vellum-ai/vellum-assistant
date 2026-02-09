import { FullNavBar } from "@/components/CommunityPage/_FullNavBar";
import { WorkflowCTA } from "@/components/VellumHomepage/WorkflowCTA";

const WEBINARS = [
  {
    date: "December 9, 2025",
    title: "How we increased our PR count by 70% in 6 months with coding agents",
    url: "https://www.vellum.ai/webinar/how-we-increased-our-pr-count-by-70-in-6-months-with-coding-agents",
  },
  {
    date: "September 3, 2025",
    title: "Vibe-coding an AI Shopping Agent in Vellum",
    url: "https://www.vellum.ai/webinar/vibe-coding-an-ai-shopping-agent-in-vellum",
  },
  {
    date: "August 27, 2025",
    title: "Vibe-coding an SEO Agent in 30 min with Vellum",
    url: "https://www.vellum.ai/webinar/vibe-coding-an-seo-agent-in-30-min-with-vellum",
  },
  {
    date: "August 13, 2025",
    title: "How to build AI agents 10x faster using Vellum and Composio",
    url: "https://www.vellum.ai/webinar/building-ai-agents-10x-faster-with-vellum-and-composio",
  },
  {
    date: "July 29, 2025",
    title: "Building AI agents that you can test, track and improve",
    url: "https://www.vellum.ai/webinar/building-ai-agents-that-you-can-test-track-and-improve",
  },
  {
    date: "May 21, 2025",
    title: "Webinar recap: Best practices on building Voice AI agents for patient triaging",
    url: "https://www.vellum.ai/webinar/best-practices-on-building-voice-ai-agents-for-patient-triaging",
  },
  {
    date: "November 6, 2024",
    title: "Coinbase's AI development journey and its million-dollar impact",
    url: "https://www.vellum.ai/webinar/coinbases-ai-development-journey-and-its-million-dollar-impact",
  },
  {
    date: "September 25, 2024",
    title: "How to Manage Your AI System Once it's in Production",
    url: "https://www.vellum.ai/webinar/how-to-manage-your-ai-system-once-its-in-production",
  },
  {
    date: "September 18, 2024",
    title: "Webinar recap: How Redfin built a reliable AI assistant and launched it nation wide",
    url: "https://www.vellum.ai/webinar/how-redfin-built-a-reliable-ai-assistant-and-launched-it-nation-wide",
  },
  {
    date: "September 11, 2024",
    title: "Turning AI ideas into working prototypes",
    url: "https://www.vellum.ai/webinars/championing-genai-bring-your-ai-systems-to-life-faster",
  },
];

const ARROW_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 17L17 7" />
    <path d="M7 7h10v10" />
  </svg>
);

export function WebinarsBody() {
  return (
    <>
      <FullNavBar />
      <main className="main-wrapper">
        <div className="section_docs">
          <div className="padding-global">
            <div className="container-new docs">
              <div className="padding-section-medium">
                <div className="webinars-header">
                  <div className="webinars-tag">VELLUM WEBINARS</div>
                  <h1 className="heading-1-new text-color-white font-playfair">
                    Learn from AI experts
                  </h1>
                  <p className="u-text-regular text-color-light-gray">
                    Each webinar session dives into practical workflows, lessons learned, and the tools that make AI work in production.
                  </p>
                </div>
                <div className="webinars-grid">
                  {WEBINARS.map((webinar) => (
                    <a
                      key={webinar.title}
                      href={webinar.url}
                      target="_blank"
                      rel="noreferrer"
                      className="webinar-card"
                    >
                      <div className="webinar-card-content">
                        <div className="webinar-date">{webinar.date}</div>
                        <h3 className="webinar-title">{webinar.title}</h3>
                      </div>
                      <div className="webinar-arrow">
                        {ARROW_ICON}
                      </div>
                    </a>
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

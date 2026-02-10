import Image from "next/image";

const LINK_ICON = (
  <svg width="100%" height="100%" viewBox="0 0 19 19" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M10.292 3.70833C10.292 3.28776 10.6383 2.91667 11.0837 2.91667H15.042C15.4626 2.91667 15.8337 3.28776 15.8337 3.70833V7.66667C15.8337 8.11198 15.4626 8.45833 15.042 8.45833C14.5967 8.45833 14.2503 8.11198 14.2503 7.66667V5.63802L9.25293 10.6107C8.95605 10.9323 8.43652 10.9323 8.13965 10.6107C7.81803 10.3138 7.81803 9.79427 8.13965 9.4974L13.1123 4.5H11.0837C10.6383 4.5 10.292 4.15365 10.292 3.70833Z" fill="url(#paint0_linear_5046_61039)" />
    <path opacity="0.4" d="M3.16699 5.6875C3.16699 4.59896 4.03288 3.70833 5.14616 3.70833H7.91699C8.33756 3.70833 8.70866 4.07943 8.70866 4.5C8.70866 4.94531 8.33756 5.29167 7.91699 5.29167H5.14616C4.9235 5.29167 4.75033 5.48958 4.75033 5.6875V13.6042C4.75033 13.8268 4.9235 14 5.14616 14H13.0628C13.2607 14 13.4587 13.8268 13.4587 13.6042V10.8333C13.4587 10.4128 13.805 10.0417 14.2503 10.0417C14.6709 10.0417 15.042 10.4128 15.042 10.8333V13.6042C15.042 14.7174 14.1514 15.5833 13.0628 15.5833H5.14616C4.03288 15.5833 3.16699 14.7174 3.16699 13.6042V5.6875Z" fill="url(#paint1_linear_5046_61039)" />
    <defs>
      <linearGradient id="paint0_linear_5046_61039" x1="9.50033" y1="3" x2="9.50033" y2="16" gradientUnits="userSpaceOnUse">
        <stop stopColor="#EBECF8" />
        <stop offset="0.51" stopColor="#D1CBD7" />
        <stop offset="1" stopColor="#C9C4DD" />
      </linearGradient>
      <linearGradient id="paint1_linear_5046_61039" x1="9.50033" y1="3" x2="9.50033" y2="16" gradientUnits="userSpaceOnUse">
        <stop stopColor="#EBECF8" />
        <stop offset="0.51" stopColor="#D1CBD7" />
        <stop offset="1" stopColor="#C9C4DD" />
      </linearGradient>
    </defs>
  </svg>
);

const ARROW_UP_RIGHT = (
  <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentcolor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-arrow-up-right h-4 w-4 text-zinc-500 transition-all group-hover:text-white">
    <path d="M7 7h10v10"></path>
    <path d="M7 17 17 7"></path>
  </svg>
);

const CTA_ARROW = (
  <svg width="100%" height="100%" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M15.9062 10.2422L11.0938 14.8359C10.8203 15.082 10.4102 15.082 10.1641 14.8086C9.91797 14.5352 9.91797 14.125 10.1914 13.8789L13.8281 10.4062H4.53125C4.14844 10.4062 3.875 10.1328 3.875 9.75C3.875 9.39453 4.14844 9.09375 4.53125 9.09375H13.8281L10.1914 5.64844C9.91797 5.40234 9.91797 4.96484 10.1641 4.71875C10.4102 4.44531 10.8477 4.44531 11.0938 4.69141L15.9062 9.28516C16.043 9.42188 16.125 9.58594 16.125 9.75C16.125 9.94141 16.043 10.1055 15.9062 10.2422Z" fill="currentcolor" />
  </svg>
);

const ROUND_BTN_ICON = (
  <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M7 7H17V17" stroke="currentcolor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M7 17L17 7" stroke="currentcolor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

interface PromptItem {
  tag: string;
  title: string;
  description: string;
  icons: string[];
}

const PROMPT_ITEMS: PromptItem[] = [
  {
    tag: "Product",
    title: "Detect declining usage trends ahead of renewals",
    description: "Create an agent that monitors product usage trends for each customer account using {{Posthog}}. Compare current usage against historical patterns and flag accounts showing declining engagement. Cross-reference with renewal dates from {{Salesforce}} and create a {{Notion}} doc with a prioritized list of at-risk accounts with recommended retention actions.",
    icons: [
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddb22bb9c44f4542f63a5_notion.svg",
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddc5081ede6a786ba24aa_posthog.svg",
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962b9c9a80a4a0850e29f23_Salesforce.com_logo.svg.png",
    ],
  },
  {
    tag: "Product",
    title: "Track team progress without standup meetings",
    description: "Create an agent that compiles daily team progress updates from {{Slack}} messages and {{Linear}} ticket activity. Summarize completed tasks, blockers, and upcoming priorities into a {{Notion}} page. Distribute the update to relevant Slack channels every morning.",
    icons: [
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg",
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6930f9a3075eb809524f9c15_linear-light-logo.svg",
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddb22bb9c44f4542f63a5_notion.svg",
    ],
  },
  {
    tag: "Marketing",
    title: "Help me write SEO optimized articles",
    description: "Create an agent that takes a keyword from a {{Google Sheets}} spreadsheet, searches the web for top-ranking articles using {{SerpAPI}}, scrapes key insights using {{Firecrawl}}, and generates a comprehensive, SEO-optimized article draft in {{Google Docs}}. The doc link should be saved back in the sheet next to the keyword.",
    icons: [
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda9b0f1cabf89a69986c_googlesheets.svg",
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962b2a352120388fb64ec71_google-docs.png",
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcb05ec3b1d692ef2656_serpapi.svg",
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda145995030959e750be_firecrawl.svg",
    ],
  },
  {
    tag: "Finance",
    title: "Flag suspicious Stripe transactions in Slack",
    description: "Build an agent that reviews incoming {{Stripe}} transactions in real-time. Flag transactions that match suspicious patterns (unusual amounts, high-risk regions, velocity anomalies). Send alerts to a designated {{Slack}} channel with transaction details and recommended actions.",
    icons: [
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg",
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/693111453ed35f6092b082cc_stripelogo.webp",
    ],
  },
  {
    tag: "Finance",
    title: "Automate KYC checks and send reports to Slack",
    description: 'Create an agent that automates "Know Your Customer" (KYC) checks. Look at customer-uploaded documents in {{Hubspot}}. Verify document validity, completeness, and expiry. Flag missing or inconsistent information and recommend follow-up actions. Output a compliance summary and send a report via {{Gmail}}. Send a report to internal {{Slack}} channel (i will provide it).',
    icons: [
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg",
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda5a0f617cd26a3287f8_gmail.svg",
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddaaac4f173d49864b86c_hubspot.svg",
    ],
  },
  {
    tag: "Finance",
    title: "Summarize my clients\u2019 portfolios weekly",
    description: "Create an agent that compiles a weekly summary of each client\u2019s investment portfolio. Pull holdings, performance, and benchmark data from a PDF. Then generate a summary for top performing assets, risk exposure and allocation drift. Using this summary generate a 5 page slide {{Gamma}} presentation. Send the slides to my clients (I'll provide their emails).",
    icons: [
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda5a0f617cd26a3287f8_gmail.svg",
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/69310434626042e1e29cace6_Gamma_Symbol_Sky.svg",
      "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6930f46630f62aed71577199_database.png",
    ],
  },
];

function PromptCard({ item }: { item: PromptItem }) {
  return (
    <div
      filter-tag={item.tag}
      prompt-item=""
      data-w-id="2893602c-25d2-ff31-ab30-cd53ddb40124"
      role="listitem"
      className="prompt-item-new w-dyn-item"
    >
      <div className="tab_wrap">
        <div className="tag_small">{item.tag}</div>
      </div>
      <div prompt-content-target="" className="prompt-collection_text hide w-richtext">
        <p>{item.description}</p>
      </div>
      <div className="prompt_header fill">
        <div className="template-title-outcome large">{item.title}</div>
        <div highlight-content="" className="highlight_rich-text w-richtext">
          <p>{"\u200D"}</p>
        </div>
        <a btn-prompt="" href="#" className="prompt_cta static w-inline-block">
          <div btn-prompt="" data-w-id="2893602c-25d2-ff31-ab30-cd53ddb4012e" className="prompt_btn hover static hide">
            <div className="icon_link w-embed">{LINK_ICON}</div>
          </div>
        </a>
        <div className="static_cta">
          <div className="w-dyn-list">
            <div role="list" className="template-integration_list w-dyn-items">
              {item.icons.map((iconSrc) => (
                <div key={iconSrc} role="listitem" className="template-integration_item is-smaller w-dyn-item">
                  <Image
                    src={iconSrc}
                    loading="lazy"
                    alt=""
                    className="template-integration_icon is-smaller"
                    width={0}
                    height={0}
                    unoptimized
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div style={{color: "rgb(113,113,122)", backgroundColor: "rgba(255,255,255,0)"}} className="dot_circ">
        <div className="icon_circ w-embed">{ARROW_UP_RIGHT}</div>
      </div>
    </div>
  );
}

export function PromptsGrid() {
  return (
    <div className="section_prompts">
      <div className="padding-global new z-index-2">
        <div className="container-new new">
          <div className="prompts_container">
            <div className="prompt_inner-wrap">
              <div className="prompt_grid-wrap">
                <div fs-cmsfilter-element="list" className="prompt_grid w-dyn-list">
                  <div role="list" className="prompt_grid-list w-dyn-items">
                    {PROMPT_ITEMS.map((item) => (
                      <PromptCard key={item.title} item={item} />
                    ))}
                  </div>
                </div>
                <div className="mt-4rem">
                  <div className="button-group is-center">
                    <a href="https://app.vellum.ai/signup" target="_blank" className="d-button base-light-without-arrow cta-request-demo new large w-inline-block">
                      <div className="btn-text nav-button-6 inherit">Get started</div>
                      <div className="btn_arrow nav-button-7 w-embed">{CTA_ARROW}</div>
                      <div className="d-button_bg-overlay nav-button-8"></div>
                      <div className="round-btn-icon w-embed">{ROUND_BTN_ICON}</div>
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="bg_blur-main dark">
        <div className="blur_home animate-pulse dark"></div>
        <div className="blur_home animate-pulse alt dark"></div>
      </div>
    </div>
  );
}

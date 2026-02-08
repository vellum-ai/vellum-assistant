import Image from "next/image";
import Link from "next/link";

const ARROW_ICON = (
  <svg width="100%" height="100%" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M15.9062 10.2422L11.0938 14.8359C10.8203 15.082 10.4102 15.082 10.1641 14.8086C9.91797 14.5352 9.91797 14.125 10.1914 13.8789L13.8281 10.4062H4.53125C4.14844 10.4062 3.875 10.1328 3.875 9.75C3.875 9.39453 4.14844 9.09375 4.53125 9.09375H13.8281L10.1914 5.64844C9.91797 5.40234 9.91797 4.96484 10.1641 4.71875C10.4102 4.44531 10.8477 4.44531 11.0938 4.69141L15.9062 9.28516C16.043 9.42188 16.125 9.58594 16.125 9.75C16.125 9.94141 16.043 10.1055 15.9062 10.2422Z" fill="currentcolor" />
  </svg>
);

const LINKEDIN_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" fill="currentcolor" viewBox="0 0 256 256">
    <path d="M216,24H40A16,16,0,0,0,24,40V216a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V40A16,16,0,0,0,216,24Zm0,192H40V40H216V216ZM96,112v64a8,8,0,0,1-16,0V112a8,8,0,0,1,16,0Zm88,28v36a8,8,0,0,1-16,0V140a20,20,0,0,0-40,0v36a8,8,0,0,1-16,0V112a8,8,0,0,1,15.79-1.78A36,36,0,0,1,184,140ZM100,84A12,12,0,1,1,88,72,12,12,0,0,1,100,84Z"></path>
  </svg>
);

const YOUTUBE_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" fill="currentcolor" viewBox="0 0 256 256">
    <path d="M164.44,121.34l-48-32A8,8,0,0,0,104,96v64a8,8,0,0,0,12.44,6.66l48-32a8,8,0,0,0,0-13.32ZM120,145.05V111l25.58,17ZM234.33,69.52a24,24,0,0,0-14.49-16.4C185.56,39.88,131,40,128,40s-57.56-.12-91.84,13.12a24,24,0,0,0-14.49,16.4C19.08,79.5,16,97.74,16,128s3.08,48.5,5.67,58.48a24,24,0,0,0,14.49,16.41C69,215.56,120.4,216,127.34,216h1.32c6.94,0,58.37-.44,91.18-13.11a24,24,0,0,0,14.49-16.41c2.59-10,5.67-28.22,5.67-58.48S236.92,79.5,234.33,69.52Zm-15.49,113a8,8,0,0,1-4.77,5.49c-31.65,12.22-85.48,12-86,12H128c-.54,0-54.33.2-86-12a8,8,0,0,1-4.77-5.49C34.8,173.39,32,156.57,32,128s2.8-45.39,5.16-54.47A8,8,0,0,1,41.93,68c30.52-11.79,81.66-12,85.85-12h.27c.54,0,54.38-.18,86,12a8,8,0,0,1,4.77,5.49C221.2,82.61,224,99.43,224,128S221.2,173.39,218.84,182.47Z"></path>
  </svg>
);

const X_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" fill="currentcolor" viewBox="0 0 256 256">
    <path d="M214.75,211.71l-62.6-98.38,61.77-67.95a8,8,0,0,0-11.84-10.76L143.24,99.34,102.75,35.71A8,8,0,0,0,96,32H48a8,8,0,0,0-6.75,12.3l62.6,98.37-61.77,68a8,8,0,1,0,11.84,10.76l58.84-64.72,40.49,63.63A8,8,0,0,0,160,224h48a8,8,0,0,0,6.75-12.29ZM164.39,208,62.57,48h29L193.43,208Z"></path>
  </svg>
);

const PRODUCT_LINKS = [
  { label: "Product updates", href: "/blog" },
  { label: "News", href: "/blog" },
  { label: "Pricing", href: "/pricing" },
  { label: "Contact Sales", href: "/landing-pages/request-demo" },
];

const RESOURCE_LINKS = [
  { label: "LLM Leaderboard", href: "/llm-leaderboard" },
  { label: "Webinars", href: "/webinars" },
  { label: "News", href: "/blog" },
  { label: "Blog", href: "/blog" },
  { label: "N8N to Vellum converter", href: "/n8n-to-vellum" },
];

const COMPANY_LINKS = [
  { label: "Affiliate program rules", href: "/docs/affiliate-program-rules", external: true },
  { label: "Terms of Use", href: "/docs/vellum-terms-of-use", external: true },
  { label: "Privacy Policy", href: "/docs/privacy-policy", external: true },
];

export function WorkflowCTA() {
  return (
    <div className="section_workflow-cta">
      <div className="sec_wrap">
        <div className="sec_bg-dot">
          <div className="hide w-embed">
            <style dangerouslySetInnerHTML={{__html: `
.sec_bg-dot {
  position: relative;
  background-color: #09090b;
  background-image: radial-gradient(
    circle,
    hsl(240 5% 65% / 0.4) 1px,
    transparent 1px
  );
  background-size: 24px 24px;
}
`}} />
          </div>
        </div>
      </div>
      <div className="padding-global new">
        <div className="container-new new">
          <div className="cta_home-head text-wrap-balance">
            <div className="mb-2-5rem">
              <h2 className="heading-2-new playfair">
                Automate the work<br />
                <em>that slows you down</em>
              </h2>
            </div>
            <div className="button-group is-center">
              <a href="https://app.vellum.ai/signup" target="_blank" className="d-button nav-button-5 js-utm-signup cta-get-started new large w-inline-block">
                <div className="btn-text nav-button-6 new">Describe your task</div>
                <div className="round-btn-icon top w-embed">
                  <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-arrow-right h-4 w-4 -rotate-90 transition-transform group-hover:-translate-y-0.5">
                    <path d="M5 12h14"></path>
                    <path d="m12 5 7 7-7 7"></path>
                  </svg>
                </div>
                <div className="btn_arrow nav-button-7 w-embed">{ARROW_ICON}</div>
                <div className="d-button_bg-overlay nav-button-8"></div>
              </a>
            </div>
          </div>
          <div className="spacer-8rem"></div>
          <div className="footer-main">
            <div className="footer_min-head">
              <div className="footer_vel-head">
                  <Link href="/" aria-current="page" className="navbar2_logo-link w-nav-brand w--current">
                    <Image
                      loading="lazy"
                      src="https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6853f41167390a6658f3fd68_Vellum%20Wordmark%20Logo.svg"
                      alt=""
                      className="navbar2_logo"
                      width={0}
                      height={0}
                      unoptimized
                    />
                  </Link>
                <div className="text-lg text-color-foreground font-inter">
                  AI agents for your boring ops tasks.<br />
                </div>
              </div>
              <div className="footer_social-wrap">
                <a href="https://www.linkedin.com/company/vellumai" target="_blank" className="footer_social-link w-inline-block">
                  <div className="icon-embed-small smaller w-embed">{LINKEDIN_ICON}</div>
                </a>
                <a href="https://www.youtube.com/@Vellum_AI" target="_blank" className="footer_social-link w-inline-block">
                  <div className="icon-embed-small smaller w-embed">{YOUTUBE_ICON}</div>
                </a>
                <a href="https://x.com/vellum_ai" target="_blank" className="footer_social-link w-inline-block">
                  <div className="icon-embed-small smaller w-embed">{X_ICON}</div>
                </a>
              </div>
            </div>
            <div className="footer_bottom-wrap">
              <div className="footer_subgrid grid-4 font-inter">
                <div className="u-vflex-stretch-top gap-main">
                  <div className="footer_head_text alt">Product</div>
                  <ul role="list" className="footer_nav_list u-vflex-stretch-top w-list-unstyled">
                    {PRODUCT_LINKS.map((link) => (
                      <li key={link.label} className="footer_link_wrap">
                        <a aria-label={`Go to ${link.label} page`} href={link.href} className="footer_link w-inline-block">
                          <div className="footer_link_text alt">{link.label}</div>
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="u-vflex-stretch-top gap-main">
                  <div className="footer_head_text alt">Resources</div>
                  <ul role="list" className="footer_nav_list u-vflex-stretch-top w-list-unstyled">
                    {RESOURCE_LINKS.map((link) => (
                      <li key={link.label} className="footer_link_wrap">
                        <a aria-label={`Go to ${link.label} page`} href={link.href} className="footer_link w-inline-block">
                          <div className="footer_link_text alt">{link.label}</div>
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="u-vflex-stretch-top gap-main">
                  <div className="footer_head_text alt">Company</div>
                  <a aria-label="Go to Careers page" href="https://jobs.ashbyhq.com/vellum" target="_blank" className="footer_link w-inline-block">
                    <div className="footer_link_text alt">Careers</div>
                  </a>
                  <div className="w-dyn-list">
                    <div role="list" className="footer_nav_list w-dyn-items">
                      {COMPANY_LINKS.map((link) => (
                        <div key={link.label} role="listitem" className="footer_link_wrap w-dyn-item">
                          <a aria-label={`Go to ${link.label} page`} href={link.href} target="_blank" className="footer_link w-inline-block">
                            <div className="footer_link_text alt">{link.label}</div>
                          </a>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * HeroSection Component
 * 
 * Extracted from vellum-homepage.html (Phase 2)
 * - Main headline ("AI agents for your boring ops tasks")
 * - JUST LAUNCHED tag with link
 * - Get on the waitlist button
 * - Category tabs with template cards
 * 
 * All Webflow classes and data-w-id attributes preserved for animations.
 */

import { CategoryTemplates } from "./CategoryTemplates";

interface Template {
  title: string;
  slug: string;
  shortDescription: string;
  heroIntroParagraph: string;
  industry: string;
  integrations: string[];
}

interface HeroSectionProps {
  templatesByCategory?: Record<string, Template[]>;
}

export function HeroSection({ templatesByCategory = {} }: HeroSectionProps) {
  return (
    <div className="section_home home">
      <div className="padding-global home z-index-2">
        <div className="container-new alt home">
          <div className="padding-section-medium">
            <div id="your-task" className="spacer-xxlarge custom">
              <div
                data-w-id="4ed9cb8c-1ad3-739e-bef1-55668c067ce7"
                style={{
                  opacity: 1,
                  WebkitTransform: 'translate3d(0, 0, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0)',
                  MozTransform: 'translate3d(0, 0, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0)',
                  msTransform: 'translate3d(0, 0, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0)',
                  transform: 'translate3d(0, 0, 0) scale3d(1, 1, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0)'
                }}
                className="hero_tag-wrapper"
              >
                <a href="https://www.vellum.ai/blog/introducing-vellum-for-agents" target="_blank" rel="noreferrer" className="tag-block w-inline-block">
                  <div className="tag_pill">JUST LAUNCHED</div>
                  <div className="text-block-130">Introducing Vellum for Agents<br/></div>
                  <div className="btn_arrow w-embed">
                    <svg width="100%" height="100%" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M15.9062 10.2422L11.0938 14.8359C10.8203 15.082 10.4102 15.082 10.1641 14.8086C9.91797 14.5352 9.91797 14.125 10.1914 13.8789L13.8281 10.4062H4.53125C4.14844 10.4062 3.875 10.1328 3.875 9.75C3.875 9.39453 4.14844 9.09375 4.53125 9.09375H13.8281L10.1914 5.64844C9.91797 5.40234 9.91797 4.96484 10.1641 4.71875C10.4102 4.44531 10.8477 4.44531 11.0938 4.69141L15.9062 9.28516C16.043 9.42188 16.125 9.58594 16.125 9.75C16.125 9.94141 16.043 10.1055 15.9062 10.2422Z" fill="currentcolor"/>
                    </svg>
                  </div>
                </a>
              </div>
            </div>

            <div className="content-hero home">
              <div className="home-hero-header">
                <div show-item="100" data-w-id="7f9ee039-070d-185b-644b-bbff59cd1239" className="text-align-center text-wrap-balance">
                  <div className="spacer-xxsmall"></div>
                  <h1 className="heading-1-new text-color-white font-playfair">
                    <em className="italic-text-12">AI agents for your<br/></em>
                    <span><em>boring ops tasks</em></span>
                  </h1>
                </div>
              </div>

              <div className="z-index-2">
                <div show-item="200" data-w-id="22864678-5e99-9d0f-532b-00df4ee940cb" className="prompt-box_main">
                  <div className="prompt-box-head">
                    <div className="prompt-box-wrap mobile-off main">
                      {/* Waitlist Button */}
                      <div style={{ 
                        display: "flex", 
                        justifyContent: "center", 
                        padding: "2rem 1.5rem",
                      }}>
                        <a 
                          href="/waitlist" 
                          className="d-button cta-get-started"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.5rem",
                            padding: "0.875rem 1.75rem",
                            backgroundColor: "#6860ff",
                            color: "#ffffff",
                            borderRadius: "8px",
                            textDecoration: "none",
                            fontSize: "1rem",
                            fontWeight: "600",
                            transition: "background-color 0.15s ease",
                          }}
                        >
                          Get on the waitlist
                          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M15.9062 10.2422L11.0938 14.8359C10.8203 15.082 10.4102 15.082 10.1641 14.8086C9.91797 14.5352 9.91797 14.125 10.1914 13.8789L13.8281 10.4062H4.53125C4.14844 10.4062 3.875 10.1328 3.875 9.75C3.875 9.39453 4.14844 9.09375 4.53125 9.09375H13.8281L10.1914 5.64844C9.91797 5.40234 9.91797 4.96484 10.1641 4.71875C10.4102 4.44531 10.8477 4.44531 11.0938 4.69141L15.9062 9.28516C16.043 9.42188 16.125 9.58594 16.125 9.75C16.125 9.94141 16.043 10.1055 15.9062 10.2422Z" fill="currentColor"/>
                          </svg>
                        </a>
                      </div>
                      
                      {/* Category Templates - Interactive tabs with template cards */}
                      <CategoryTemplates templatesByCategory={templatesByCategory} />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Spacer for layout */}
            <div show-item="300" data-w-id="2b66fe54-1231-1b48-759b-cb802ac91fc1" className="spacer-xxlarge hide-mobile new hero">
              <div prompt-boxs="" className="prompt-box_main is-max-width">
                <div className="prompts-collection w-dyn-list">
                  <div fs-list-element="list" role="list" className="prompts-collection_list w-dyn-items">
                    {/* Dynamic prompt items would go here */}
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

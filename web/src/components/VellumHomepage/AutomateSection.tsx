/**
 * AutomateSection Component
 * 
 * Extracted from vellum-homepage.html (Phase 2)
 * - "Hey Vellum, automate my" section with dropdown
 * - Tab interface for different automation examples
 * - SEO writing process, Sales meeting prep, Customer activity reports
 * 
 * All Webflow classes and data-w-id attributes preserved for animations.
 * Note: This is a simplified version for Phase 2. Full interactive tabs
 * and animations will be properly implemented in Phase 3.
 */

export function AutomateSection() {
  return (
    <div className="section_automate">
      <div className="padding-global new z-index-2">
        <div className="container-new new">
          <div className="text-align-center">
            <div className="automate_tab-wrapper">
              <h2 className="heading-2-new">Hey Vellum, automate my<br/></h2>
              <div 
                data-hover="false" 
                data-delay="300" 
                id="dd-lottie" 
                data-w-id="3f907715-ff5a-966c-4964-42b94ebadc56" 
                className="dropdown_item w-dropdown"
              >
                <div className="dropdown_toggle-item w-dropdown-toggle">
                  <div target-text="">SEO writing process</div>
                  <div className="icon-1x1-small w-embed">
                    <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" fill="currentcolor" viewBox="0 0 256 256">
                      <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"></path>
                    </svg>
                  </div>
                </div>
                <nav 
                  style={{
                    WebkitTransform: 'translate3d(0, 0, 0) scale3d(0.95, 0.95, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0)',
                    MozTransform: 'translate3d(0, 0, 0) scale3d(0.95, 0.95, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0)',
                    msTransform: 'translate3d(0, 0, 0) scale3d(0.95, 0.95, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0)',
                    transform: 'translate3d(0, 0, 0) scale3d(0.95, 0.95, 1) rotateX(0) rotateY(0) rotateZ(0) skew(0, 0)',
                    opacity: 0
                  }} 
                  className="automate_nav-sub w-dropdown-list"
                >
                  <a fs-mirrorclick-instance="seo" target-text-select="" href="#" className="automate_link-tab is-active w-dropdown-link">
                    SEO writing process
                  </a>
                  <a fs-mirrorclick-instance="sales" target-text-select="" href="#" className="automate_link-tab w-dropdown-link">
                    Sales meeting prep
                  </a>
                  <a fs-mirrorclick-instance="report" target-text-select="" href="#" className="automate_link-tab w-dropdown-link">
                    Customer activity reports
                  </a>
                </nav>
              </div>
            </div>

            {/* Simplified tab content - Phase 3 will add full interactive functionality */}
            <div data-current="Tab 1" data-easing="ease" data-duration-in="0" data-duration-out="0" className="task_tab-wrapper w-tabs">
              <div className="task_tab-main hide w-tab-menu">
                <a data-w-tab="Tab 1" fs-mirrorclick-instance="seo" data-w-id="878c7017-850b-58e3-0e46-88e7e31b940a" className="task_tab-link w-inline-block w-tab-link w--current">
                  <div>SEO writing process</div>
                </a>
                <a data-w-tab="Tab 2" fs-mirrorclick-instance="sales" data-w-id="878c7017-850b-58e3-0e46-88e7e31b940d" className="task_tab-link w-inline-block w-tab-link">
                  <div>Sales meeting prep</div>
                </a>
                <a data-w-tab="Tab 3" fs-mirrorclick-instance="report" data-w-id="878c7017-850b-58e3-0e46-88e7e31b9410" className="task_tab-link w-inline-block w-tab-link">
                  <div>Customer activity reports</div>
                </a>
              </div>
              
              <div className="task_tab-main-wrap w-tab-content">
                {/* Tab 1: SEO writing process */}
                <div data-w-tab="Tab 1" className="w-tab-pane w--tab-active">
                  <div data-current="Tab 1" data-easing="ease" data-duration-in="300" data-duration-out="100" className="w-tabs">
                    <div className="task_tabs-mobile w-tab-menu">
                      <a data-w-tab="Tab 1" className="task_mobile-link w-inline-block w-tab-link w--current">
                        <div className="text-size-medium">Instructions</div>
                      </a>
                      <a data-w-tab="Tab 2" className="task_mobile-link w-inline-block w-tab-link">
                        <div className="text-size-medium">Workflow preview</div>
                      </a>
                    </div>
                    <div className="w-tab-content">
                      <div data-w-tab="Tab 1" className="w-tab-pane w--tab-active">
                        <div data-w-id="b6ef896b-6e1e-1ef9-84f1-af8b51dcba16" className="task_tab">
                          <div className="task_tab-content">
                            <div agent-prompt-1="" className="tab_chat-bubble">
                              I want to build an agent that looks at keywords in Google Sheet, researches top ranking articles, and creates a draft for me in a Google Doc every day at 9am
                            </div>
                            <div className="answer_content">
                              <div style={{opacity: 0}} className="author_profile-bubble">
                                <div className="profile_bubble">
                                  <img loading="lazy" src="https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/695d3a4a6aad5db1c35ab4a3_vellum-logo-icon.svg" alt="" className="icon_vellum"/>
                                </div>
                                <div>Vellum</div>
                              </div>
                              <div style={{opacity: 0}} className="chat_progress-flex">
                                <div className="text-top-ans">I&apos;ve built your SEO/GEO agent. Here&apos;s what it does:<br/></div>
                                <ol role="list" className="list_answer">
                                  <li><div><span className="text-top-ans">Gets a keyword</span> from a sheet</div></li>
                                  <li><div><span className="text-top-ans">Analyzes</span> SEO intent and researches sources</div></li>
                                  <li><div><span className="text-top-ans">Writes an article</span> draft in Google Docs</div></li>
                                  <li><div><span className="text-top-ans">Logs the doc link</span> in a Google Sheet next to your keyword</div></li>
                                </ol>
                              </div>
                              <a 
                                agent-trigger-1="" 
                                style={{opacity: 0}} 
                                href="#" 
                                target="_blank" 
                                rel="noreferrer"
                                className="d-button nav-button-5 js-utm-signup cta-get-started tab w-inline-block"
                              >
                                <div className="btn-text nav-button-6 new">I want this agent</div>
                                <div className="icon-prompt w-embed">
                                  <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" fill="currentcolor" viewBox="0 0 256 256">
                                    <path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z"></path>
                                  </svg>
                                </div>
                                <div className="btn_arrow nav-button-7 w-embed">
                                  <svg width="100%" height="100%" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M15.9062 10.2422L11.0938 14.8359C10.8203 15.082 10.4102 15.082 10.1641 14.8086C9.91797 14.5352 9.91797 14.125 10.1914 13.8789L13.8281 10.4062H4.53125C4.14844 10.4062 3.875 10.1328 3.875 9.75C3.875 9.39453 4.14844 9.09375 4.53125 9.09375H13.8281L10.1914 5.64844C9.91797 5.40234 9.91797 4.96484 10.1641 4.71875C10.4102 4.44531 10.8477 4.44531 11.0938 4.69141L15.9062 9.28516C16.043 9.42188 16.125 9.58594 16.125 9.75C16.125 9.94141 16.043 10.1055 15.9062 10.2422Z" fill="currentcolor"/>
                                  </svg>
                                </div>
                                <div className="d-button_bg-overlay nav-button-8"></div>
                              </a>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                {/* Note: Tab 2 and Tab 3 content would go here - simplified for Phase 2 */}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

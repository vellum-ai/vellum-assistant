/**
 * HeroSection Component
 * 
 * Extracted from vellum-homepage.html (Phase 2)
 * - Main headline ("AI agents for your boring ops tasks")
 * - JUST LAUNCHED tag with link
 * - Prompt input box with textarea and upload button
 * 
 * All Webflow classes and data-w-id attributes preserved for animations.
 */

export function HeroSection() {
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
                      <div className="pompt-main-block alt">
                        <div json-area="" className="json_uploader-wrapper"></div>
                        <div className="prompt_form-block w-form">
                          <form id="email-form" name="email-form" data-name="Email Form" method="get" className="prompt_form alt" data-wf-page-id="69425ca6dc666af71b39217d" data-wf-element-id="01590f1f-1053-5ad9-b604-cbde933afbcf">
                            <div className="input-wrapper">
                              <textarea prompt-input="" className="input-prompt text_area is-white not-show w-input" autoFocus={true} maxLength={5000} name="Prompt" data-name="Prompt" auto-grow="" placeholder="Tell Vellum what you want to automate..." id="Prompt"></textarea>
                              <div className="prompt-dummy_text-show"></div>
                              <div highlights-text="" className="hide">Create</div>
                              <div className="hide"><div className="text-active">create</div></div>
                            </div>
                            <div className="prompt_box-cotrols ab">
                              <div data-hover="false" data-delay="0" upload-json-dropdown="" className="prompt_btn json_btn alt w-dropdown">
                                <div className="toggle-dropdown w-dropdown-toggle">
                                  <div className="icon-prompt w-embed">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" fill="#A2A2AA" viewBox="0 0 256 256">
                                      <path d="M209.66,122.34a8,8,0,0,1,0,11.32l-82.05,82a56,56,0,0,1-79.2-79.21L147.67,35.73a40,40,0,1,1,56.61,56.55L105,193A24,24,0,1,1,71,159L154.3,74.38A8,8,0,1,1,165.7,85.6L82.39,170.31a8,8,0,1,0,11.27,11.36L192.93,81A24,24,0,1,0,159,47L59.76,147.68a40,40,0,1,0,56.53,56.62l82.06-82A8,8,0,0,1,209.66,122.34Z"></path>
                                    </svg>
                                  </div>
                                </div>
                                <nav className="sub_navigation w-dropdown-list">
                                  <div>Convert your N8N json</div>
                                  <div className="styled_json-box">
                                    <input type="file" accept=".json" upload-btn="" className="d-button upload show-on"/>
                                    <div className="hide pointer">
                                      <div className="is-center"></div>
                                      <div className="hide w-embed">
                                        <style dangerouslySetInnerHTML={{__html: `[upload-btn] { cursor: pointer !important; }`}} />
                                      </div>
                                    </div>
                                    <div className="json_icon">
                                      <div className="icon_json w-embed">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" fill="currentcolor" viewBox="0 0 256 256">
                                          <path d="M181.66,146.34a8,8,0,0,1,0,11.32l-24,24a8,8,0,0,1-11.32-11.32L164.69,152l-18.35-18.34a8,8,0,0,1,11.32-11.32Zm-72-24a8,8,0,0,0-11.32,0l-24,24a8,8,0,0,0,0,11.32l24,24a8,8,0,0,0,11.32-11.32L91.31,152l18.35-18.34A8,8,0,0,0,109.66,122.34ZM216,88V216a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V40A16,16,0,0,1,56,24h96a8,8,0,0,1,5.66,2.34l56,56A8,8,0,0,1,216,88Zm-56-8h28.69L160,51.31Zm40,136V96H152a8,8,0,0,1-8-8V40H56V216H200Z"></path>
                                        </svg>
                                      </div>
                                    </div>
                                    <div upload-text="" className="text_json">Upload JSON</div>
                                  </div>
                                </nav>
                              </div>
                              <a run-prompt="" href="#" className="prompt_btn run cta-run-prompt w-inline-block">
                                <div className="icon-prompt w-embed">
                                  <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" fill="currentcolor" viewBox="0 0 256 256">
                                    <path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z"></path>
                                  </svg>
                                </div>
                              </a>
                            </div>
                            <div className="hide w-embed">
                              <style dangerouslySetInnerHTML={{__html: `.input-prompt { resize: none; overflow: auto; }`}} />
                            </div>
                          </form>
                          <div className="w-form-done"><div>Thank you! Your submission has been received!</div></div>
                          <div className="w-form-fail"><div>Oops! Something went wrong while submitting the form.</div></div>
                        </div>
                      </div>
                      {/* Form filter section with tags truncated for brevity - keeping structure */}
                      <div className="form_filter alt hide-mobile w-form">
                        <form id="wf-form-Filter" name="wf-form-Filter" data-name="Filter" method="get" fs-list-element="filters" data-wf-page-id="69425ca6dc666af71b39217d" data-wf-element-id="5c824377-8880-f5b2-e6f3-c4e1eaa3d650">
                          <div className="prompt_box-tags-wrapper hide-mobile alt">
                            <div className="collection_hero w-dyn-list">
                              <div role="list" className="template_tags-wrapper w-dyn-items">
                                {['Product', 'Sales', 'Marketing', 'Finance', 'Customer support'].map(tag => (
                                  <div key={tag} role="listitem" className="item_radio inter w-dyn-item">
                                    <label className="template_text-tag w-radio" htmlFor="radio">
                                      <input type="radio" name="radio" id="radio" data-name="Radio" fs-list-activeclass="is-active" className="w-form-formradioinput hide w-radio-input" value="Radio"/>
                                      <span className="label-text w-form-label">{tag}</span>
                                    </label>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        </form>
                        <div className="w-form-done"><div>Thank you! Your submission has been received!</div></div>
                        <div className="w-form-fail"><div>Oops! Something went wrong while submitting the form.</div></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Placeholder for prompt boxes collection - would be dynamically loaded in production */}
            <div show-item="300" data-w-id="2b66fe54-1231-1b48-759b-cb802ac91fc1" className="spacer-xxlarge hide-mobile new hero">
              <div prompt-boxs="" className="prompt-box_main is-max-width">
                <div className="prompts-collection w-dyn-list">
                  <div fs-list-element="list" role="list" className="prompts-collection_list w-dyn-items">
                    {/* Dynamic prompt items would go here - keeping structure minimal for now */}
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

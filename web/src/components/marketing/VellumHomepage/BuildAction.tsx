"use client";

import { useEffect } from "react";

const RUN_ITEMS= [
  {
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="0.85rem" height="0.85rem" fill="#a78bfa" viewBox="0 0 256 256">
        <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z"></path>
      </svg>
    ),
    label: "Trigger",
    detail: "triggered at 9:15 AM",
    time: "0.1s",
  },
  {
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="0.85rem" height="0.85rem" fill="#a78bfa" viewBox="0 0 256 256">
        <path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Z"></path>
      </svg>
    ),
    label: "Fetch keyword from sheet",
    detail: '"best crm software 2025"',
    time: "0.8s",
  },
  {
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="0.85rem" height="0.85rem" fill="#a78bfa" viewBox="0 0 256 256">
        <path d="M128,24h0A104,104,0,1,0,232,128,104.12,104.12,0,0,0,128,24Zm88,104a87.61,87.61,0,0,1-3.33,24H174.16a157.44,157.44,0,0,0,0-48h38.51A87.61,87.61,0,0,1,216,128ZM102,168H154a115.11,115.11,0,0,1-26,45A115.27,115.27,0,0,1,102,168Zm-3.9-16a140.84,140.84,0,0,1,0-48h59.88a140.84,140.84,0,0,1,0,48ZM40,128a87.61,87.61,0,0,1,3.33-24H81.84a157.44,157.44,0,0,0,0,48H43.33A87.61,87.61,0,0,1,40,128ZM154,88H102a115.11,115.11,0,0,1,26-45A115.27,115.27,0,0,1,154,88Zm52.33,0H170.71a135.28,135.28,0,0,0-22.3-45.6A88.29,88.29,0,0,1,206.37,88ZM107.59,42.4A135.28,135.28,0,0,0,85.29,88H49.63A88.29,88.29,0,0,1,107.59,42.4ZM49.63,168H85.29a135.28,135.28,0,0,0,22.3,45.6A88.29,88.29,0,0,1,49.63,168Zm98.78,45.6a135.28,135.28,0,0,0,22.3-45.6h35.66A88.29,88.29,0,0,1,148.41,213.6Z"></path>
      </svg>
    ),
    label: "Search top articles",
    detail: "analyzed 8 articles",
    time: "2.1s",
  },
  {
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="0.85rem" height="0.85rem" fill="#a78bfa" viewBox="0 0 256 256">
        <path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z"></path>
      </svg>
    ),
    label: "Generate article draft",
    detail: "2,450 words",
    time: "3.2s",
  },
  {
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="0.85rem" height="0.85rem" fill="#a78bfa" viewBox="0 0 256 256">
        <path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Z"></path>
      </svg>
    ),
    label: "Save to Google Docs",
    detail: "doc linked in sheet",
    time: "1.9s",
  },
];

export function BuildAction() {
  useEffect(() => {
    const initialClickEl = document.querySelector("[initial-click]");
    if (initialClickEl) {
      (initialClickEl as HTMLElement).click();
    }
  }, []);

  return (
    <div className="section_build-action">
      <div className="hide w-embed">
        <style dangerouslySetInnerHTML={{__html: `
.section_build-action {
  background: radial-gradient(80% 60% at 80% 100%, rgba(139, 92, 246, 0.2) 0%, transparent 50%), radial-gradient(60% 50% at 90% 80%, rgba(236, 72, 153, 0.15) 0%, transparent 45%), rgb(249, 250, 251);
}
`}} />
      </div>
      <div className="padding-global new">
        <div className="container-new new">
          <div className="action_sec-header">
            <h2 className="heading-2-new is-dark">Understand how your agent makes decisions</h2>
          </div>
          <div className="action_tab-wrapper">
            <div data-current="Tab 2" data-easing="ease" data-duration-in="300" data-duration-out="100" className="action_tab w-tabs">
              <div className="action_tab-menu w-tab-menu">
                <a data-w-tab="Tab 1" className="action_tab-link w-inline-block w-tab-link">
                  <div className="tab_icon w-embed">
                    <svg xmlns="http://www.w3.org/2000/svg" width="1rem" height="1rem" fill="currentcolor" viewBox="0 0 256 256">
                      <path d="M128,24h0A104,104,0,1,0,232,128,104.12,104.12,0,0,0,128,24Zm88,104a87.61,87.61,0,0,1-3.33,24H174.16a157.44,157.44,0,0,0,0-48h38.51A87.61,87.61,0,0,1,216,128ZM102,168H154a115.11,115.11,0,0,1-26,45A115.27,115.27,0,0,1,102,168Zm-3.9-16a140.84,140.84,0,0,1,0-48h59.88a140.84,140.84,0,0,1,0,48ZM40,128a87.61,87.61,0,0,1,3.33-24H81.84a157.44,157.44,0,0,0,0,48H43.33A87.61,87.61,0,0,1,40,128ZM154,88H102a115.11,115.11,0,0,1,26-45A115.27,115.27,0,0,1,154,88Zm52.33,0H170.71a135.28,135.28,0,0,0-22.3-45.6A88.29,88.29,0,0,1,206.37,88ZM107.59,42.4A135.28,135.28,0,0,0,85.29,88H49.63A88.29,88.29,0,0,1,107.59,42.4ZM49.63,168H85.29a135.28,135.28,0,0,0,22.3,45.6A88.29,88.29,0,0,1,49.63,168Zm98.78,45.6a135.28,135.28,0,0,0,22.3-45.6h35.66A88.29,88.29,0,0,1,148.41,213.6Z"></path>
                    </svg>
                  </div>
                  <div>AI Workflow</div>
                </a>
                <a data-w-tab="Tab 2" initial-click="" className="action_tab-link w-inline-block w-tab-link w--current">
                  <div className="tab_icon w-embed">
                    <svg xmlns="http://www.w3.org/2000/svg" width="1rem" height="1rem" fill="currentcolor" viewBox="0 0 256 256">
                      <path d="M240,128a8,8,0,0,1-8,8H204.94l-37.78,75.58A8,8,0,0,1,160,216h-.4a8,8,0,0,1-7.08-5.14L95.35,60.76,63.28,131.31A8,8,0,0,1,56,136H24a8,8,0,0,1,0-16H50.85L88.72,36.69a8,8,0,0,1,14.76.46l57.51,151,31.85-63.71A8,8,0,0,1,200,120h32A8,8,0,0,1,240,128Z"></path>
                    </svg>
                  </div>
                  <div>Run</div>
                </a>
                <a data-w-tab="Tab 3" className="action_tab-link w-inline-block w-tab-link">
                  <div className="tab_icon w-embed">
                    <svg xmlns="http://www.w3.org/2000/svg" width="1rem" height="1rem" fill="currentcolor" viewBox="0 0 256 256">
                      <path d="M69.12,94.15,28.5,128l40.62,33.85a8,8,0,1,1-10.24,12.29l-48-40a8,8,0,0,1,0-12.29l48-40a8,8,0,0,1,10.24,12.3Zm176,27.7-48-40a8,8,0,1,0-10.24,12.3L227.5,128l-40.62,33.85a8,8,0,1,0,10.24,12.29l48-40a8,8,0,0,0,0-12.29ZM162.73,32.48a8,8,0,0,0-10.25,4.79l-64,176a8,8,0,0,0,4.79,10.26A8.14,8.14,0,0,0,96,224a8,8,0,0,0,7.52-5.27l64-176A8,8,0,0,0,162.73,32.48Z"></path>
                    </svg>
                  </div>
                  <div>Code</div>
                </a>
              </div>
              <div className="action_tab-content w-tab-content">
                <div data-w-tab="Tab 1" className="action_tab-pane w-tab-pane">
                  <div className="tab_action-text">Preview the full workflow before it runs.<br /></div>
                  <div className="workflow_tab is-white">
                    <div
                      className="image-cover-ai"
                      data-w-id="ea5a7f96-7e97-1df2-7d16-718561ac6ef4"
                      data-animation-type="lottie"
                      data-src="https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/69616268c68a3b9113faf55d_Scene%201%20(1).lottie"
                      data-loop="1"
                      data-direction="1"
                      data-autoplay="1"
                      data-is-ix2-target="0"
                      data-renderer="svg"
                      data-default-duration="0"
                      data-duration="1.0666666666666667"
                    ></div>
                  </div>
                </div>
                <div data-w-tab="Tab 2" className="action_tab-pane w-tab-pane w--tab-active">
                  <div className="tab_action-text">Discover what&apos;s happening at every step.</div>
                  <div className="action_content">
                    <div className="action_content-left first">
                      <div className="run_header">
                        <div className="run_heading">Run details</div>
                        <div className="secs_run">8.30s total</div>
                      </div>
                      <div className="run_items-wrapper">
                        {RUN_ITEMS.map((item, index) => (
                          <div key={index} className="run_item">
                            <div className="run_icon">
                              <div className="run_icon-inner w-embed">{item.icon}</div>
                            </div>
                            <div className="run_item-text">
                              <div className="run_label">{item.label}</div>
                              <div className="run_detail">{item.detail}</div>
                            </div>
                            <div className="run_time">{item.time}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="action_content-right">
                      <div className="code_block">
                        <div className="code_header">
                          <div className="code_title">Output</div>
                        </div>
                        <div className="item_code">
                          <div className="code_text w-embed">
                            <pre style={{margin: 0, fontSize: '0.75rem', lineHeight: '1.5', color: '#e2e8f0'}}>
{`{
  "keyword": "best crm software 2025",
  "articles_analyzed": 8,
  "word_count": 2450,
  "google_doc_url": "https://docs.google.com/...",
  "status": "completed"
}`}
                            </pre>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div data-w-tab="Tab 3" className="action_tab-pane w-tab-pane">
                  <div className="tab_action-text">Fine-tune your agent with code when you need to.</div>
                  <div className="code_tab-content">
                    <div className="item_code">
                      <div className="code_text w-embed">
                        <pre style={{margin: 0, fontSize: '0.75rem', lineHeight: '1.5', color: '#e2e8f0'}}>
{`from vellum import Vellum

client = Vellum(api_key="YOUR_API_KEY")

result = client.execute_workflow(
    workflow_deployment_name="seo-writing-agent",
    inputs=[{
        "name": "keyword",
        "type": "STRING",
        "value": "best crm software 2025"
    }]
)

print(result.outputs)`}
                        </pre>
                      </div>
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

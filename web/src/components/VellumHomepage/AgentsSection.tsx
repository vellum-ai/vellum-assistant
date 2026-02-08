const ARROW_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" width="1rem" height="1rem" fill="currentcolor" viewBox="0 0 256 256">
    <path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z"></path>
  </svg>
);

const CODE_ICON = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M18 16L22 12L18 8" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M6 8L2 12L6 16" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M14.5 4L9.5 20" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CLOCK_ICON = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g clipPath="url(#clip0_2477_89)">
      <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 6V12L16 14" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </g>
    <defs>
      <clipPath id="clip0_2477_89">
        <rect width="24" height="24" fill="white" />
      </clipPath>
    </defs>
  </svg>
);

const SHARE_ICON = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g clipPath="url(#clip0_2477_95)">
      <path d="M4 12V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V12" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 6L12 2L8 6" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 2V15" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </g>
    <defs>
      <clipPath id="clip0_2477_95">
        <rect width="24" height="24" fill="white" />
      </clipPath>
    </defs>
  </svg>
);

const PLAY_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" width="1.2rem" height="1.2rem" fill="#ffffff" viewBox="0 0 256 256">
    <path d="M232.4,114.49,88.32,26.35a16,16,0,0,0-16.2-.3A15.86,15.86,0,0,0,64,39.87V216.13A15.94,15.94,0,0,0,80,232a16.07,16.07,0,0,0,8.36-2.35L232.4,141.51a15.81,15.81,0,0,0,0-27ZM80,215.94V40l143.83,88Z"></path>
  </svg>
);

interface TabData {
  id: string;
  icon: React.ReactNode;
  iconClass: string;
  title: string;
  description: string;
  imageClass: string;
  imageSrcSet: string;
  imageSrc: string;
}

const TABS: TabData[] = [
  {
    id: "Tab 1",
    icon: PLAY_ICON,
    iconClass: "_1",
    title: "Use via UI",
    description: "Run your agent through a built in UI.",
    imageClass: "",
    imageSrcSet: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/695e93f3807b5993ab253083_Screenshot%202026-01-07%20at%2010.42.13%E2%80%AFPM-p-500.webp 500w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/695e93f3807b5993ab253083_Screenshot%202026-01-07%20at%2010.42.13%E2%80%AFPM-p-800.webp 800w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/695e93f3807b5993ab253083_Screenshot%202026-01-07%20at%2010.42.13%E2%80%AFPM.webp 1076w",
    imageSrc: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/695e93f3807b5993ab253083_Screenshot%202026-01-07%20at%2010.42.13%E2%80%AFPM.webp",
  },
  {
    id: "Tab 2",
    icon: CODE_ICON,
    iconClass: "_2",
    title: "Run from code",
    description: "Call the agent from your app or backend.",
    imageClass: " _2",
    imageSrcSet: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/695e941e1d466fece01599b4_Screenshot%202026-01-07%20at%2010.42.52%E2%80%AFPM-p-500.webp 500w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/695e941e1d466fece01599b4_Screenshot%202026-01-07%20at%2010.42.52%E2%80%AFPM-p-800.webp 800w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/695e941e1d466fece01599b4_Screenshot%202026-01-07%20at%2010.42.52%E2%80%AFPM.webp 1084w",
    imageSrc: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/695e941e1d466fece01599b4_Screenshot%202026-01-07%20at%2010.42.52%E2%80%AFPM.webp",
  },
  {
    id: "Tab 3",
    icon: CLOCK_ICON,
    iconClass: "_3",
    title: "Trigger automatically",
    description: "Run on a schedule or in response to events.",
    imageClass: " _3",
    imageSrcSet: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/695e943ea405e03960ce7823_Screenshot%202026-01-07%20at%2010.43.29%E2%80%AFPM-p-500.webp 500w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/695e943ea405e03960ce7823_Screenshot%202026-01-07%20at%2010.43.29%E2%80%AFPM-p-800.webp 800w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/695e943ea405e03960ce7823_Screenshot%202026-01-07%20at%2010.43.29%E2%80%AFPM.webp 1078w",
    imageSrc: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/695e943ea405e03960ce7823_Screenshot%202026-01-07%20at%2010.43.29%E2%80%AFPM.webp",
  },
  {
    id: "Tab 4",
    icon: SHARE_ICON,
    iconClass: "sides",
    title: "Custom UI",
    description: "Vibe-code your own custom interface.",
    imageClass: " _4",
    imageSrcSet: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/695e962f2bbf878eb038e02a_Screenshot%202026-01-07%20at%2010.51.45%E2%80%AFPM-p-500.webp 500w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/695e962f2bbf878eb038e02a_Screenshot%202026-01-07%20at%2010.51.45%E2%80%AFPM-p-800.webp 800w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/695e962f2bbf878eb038e02a_Screenshot%202026-01-07%20at%2010.51.45%E2%80%AFPM.webp 1080w",
    imageSrc: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/695e962f2bbf878eb038e02a_Screenshot%202026-01-07%20at%2010.51.45%E2%80%AFPM.webp",
  },
];

const CUSTOM_UI_ICONS = [
  {
    cls: "_1",
    srcSet: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948ebd5a96000007b63bdda_lovable-icon-C0ABZ1TR-p-500.webp 500w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948ebd5a96000007b63bdda_lovable-icon-C0ABZ1TR-p-800.webp 800w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948ebd5a96000007b63bdda_lovable-icon-C0ABZ1TR.webp 1024w",
    src: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948ebd5a96000007b63bdda_lovable-icon-C0ABZ1TR.webp",
    sizes: "(max-width: 1024px) 100vw, 1024px, 100vw",
  },
  {
    cls: "_2",
    src: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948ebd262287c0574a59224_replit-ClGuU9zl.webp",
  },
  {
    cls: "_3",
    srcSet: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948ebcfffa7a2d5e6356cf0_base44-CSR-MIYW-p-500.webp 500w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948ebcfffa7a2d5e6356cf0_base44-CSR-MIYW-p-800.webp 800w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948ebcfffa7a2d5e6356cf0_base44-CSR-MIYW.webp 1113w",
    src: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948ebcfffa7a2d5e6356cf0_base44-CSR-MIYW.webp",
    sizes: "(max-width: 1113px) 100vw, 1113px, 100vw",
  },
  {
    cls: "last",
    srcSet: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948ebcbc5319be65c126836_v0-DOOGr_2x-p-500.webp 500w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948ebcbc5319be65c126836_v0-DOOGr_2x.webp 1024w",
    src: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948ebcbc5319be65c126836_v0-DOOGr_2x.webp",
    sizes: "(max-width: 1024px) 100vw, 1024px, 100vw",
  },
];

const MOBILE_IMAGES = [
  {
    cls: "",
    srcSet: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fd174acb623675da1cae_1-p-500.webp 500w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fd174acb623675da1cae_1-p-800.webp 800w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fd174acb623675da1cae_1-p-1080.webp 1080w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fd174acb623675da1cae_1.webp 1560w",
    src: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fd174acb623675da1cae_1.webp",
  },
  {
    cls: " _2",
    srcSet: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fc09c8fe757898353cb6_2-p-500.webp 500w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fc09c8fe757898353cb6_2-p-800.webp 800w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fc09c8fe757898353cb6_2-p-1080.webp 1080w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fc09c8fe757898353cb6_2.webp 1560w",
    src: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fc09c8fe757898353cb6_2.webp",
  },
  {
    cls: " _3",
    srcSet: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fc09ba889049414805fd_3-p-500.webp 500w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fc09ba889049414805fd_3-p-800.webp 800w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fc09ba889049414805fd_3-p-1080.webp 1080w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fc09ba889049414805fd_3.webp 1560w",
    src: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fc09ba889049414805fd_3.webp",
  },
  {
    cls: " _4",
    srcSet: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fc0930e31bf69728f5fc_4-p-500.webp 500w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fc0930e31bf69728f5fc_4-p-800.webp 800w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fc0930e31bf69728f5fc_4-p-1080.webp 1080w, https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fc0930e31bf69728f5fc_4.webp 1560w",
    src: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6948fc0930e31bf69728f5fc_4.webp",
  },
];

function TabIcon({ tab }: { tab: TabData }) {
  if (tab.iconClass === "sides") {
    return (
      <div className="agent_icon-main sides">
        {CUSTOM_UI_ICONS.map((icon) => (
          <div key={icon.cls} className={`icon_sides ${icon.cls}`}>
            <img
              sizes={icon.sizes || "100vw"}
              srcSet={icon.srcSet}
              alt=""
              src={icon.src}
              loading="lazy"
              className="image-cover"
            />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={`agent_icon-main ${tab.iconClass}`}>
      <div className="icon_tab w-embed">{tab.icon}</div>
    </div>
  );
}

function DesktopTabLink({ tab, isActive }: { tab: TabData; isActive: boolean }) {
  return (
    <a
      data-w-tab={tab.id}
      className={`agent_tab-link w-inline-block w-tab-link${isActive ? " w--current" : ""}`}
    >
      <div className="tab_agent-content">
        <div className="agent_head">
          <TabIcon tab={tab} />
          <div>
            <div className="agent_heading-tab">{tab.title}</div>
            <div className="ahent_tab-short">{tab.description}</div>
          </div>
        </div>
        <div className="arrow_agent-tab">
          <div className="arrow_div w-embed">{ARROW_ICON}</div>
        </div>
      </div>
    </a>
  );
}

function DesktopTabPane({ tab, isActive }: { tab: TabData; isActive: boolean }) {
  return (
    <div
      data-w-tab={tab.id}
      className={`tab_agent-img-pane ${tab.iconClass} w-tab-pane${isActive ? " w--tab-active" : ""}`}
    >
      <div className={`tab_image-main-wrap${tab.imageClass}`}>
        <img
          sizes={tab.iconClass === "_1" ? "(max-width: 1076px) 100vw, 1076px, 100vw" : "100vw"}
          srcSet={tab.imageSrcSet}
          alt=""
          src={tab.imageSrc}
          loading="lazy"
          className="image-cover fit"
        />
      </div>
    </div>
  );
}

function MobileAccordionItem({ tab, index, isActive }: { tab: TabData; index: number; isActive: boolean }) {
  return (
    <div className={`add-ons_accordion-item add-ons_js-accordion-item${isActive ? " active" : ""}`}>
      <div
        aria-expanded="false"
        role="button"
        tabIndex={0}
        className="agent_tab-link add-ons_js-accordion-header"
      >
        <div className="tab_agent-content">
          <div className="agent_head">
            <TabIcon tab={tab} />
            <div>
              <div className="agent_heading-tab">{tab.title}</div>
              <div className="ahent_tab-short">{tab.description}</div>
            </div>
          </div>
        </div>
      </div>
      <div className="tab_agent-img-pane add-ons_js-accordion-body">
        <div className={`tab_image-main-wrap${MOBILE_IMAGES[index].cls}`}>
          <img
            sizes="100vw"
            srcSet={MOBILE_IMAGES[index].srcSet}
            alt=""
            src={MOBILE_IMAGES[index].src}
            loading="lazy"
            className="image-cover mobile"
          />
        </div>
      </div>
    </div>
  );
}

export function AgentsSection() {
  return (
    <div className="section_agents">
      <div className="padding-global new z-index-2">
        <div className="container-new new">
          <div className="mb-5rem">
            <div className="action_sec-header">
              <h2 className="heading-2-new is-dark">Interact with your agents</h2>
              <div className="spacer-xxsmall"></div>
              <div className="max-w-xl">
                <div className="text-lg">
                  Use a built in UI for quick interactions, and switch to other modes when you need more control.<br />
                </div>
              </div>
            </div>
          </div>
          <div className="hide-tablet-custom">
            <div
              data-current="Tab 1"
              data-easing="ease"
              data-duration-in="300"
              data-duration-out="100"
              className="grid-cols-2 grid-gap-1-5rem none w-tabs"
            >
              <div
                id="w-node-_13a56389-1e09-4d35-1cd4-ad974e36738c-1b39217d"
                className="grid-col-1 gap-0-5rem w-tab-menu"
              >
                {TABS.map((tab, i) => (
                  <DesktopTabLink key={tab.id} tab={tab} isActive={i === 0} />
                ))}
              </div>
              <div className="tab_agent-img-wrap w-tab-content">
                {TABS.map((tab, i) => (
                  <DesktopTabPane key={tab.id} tab={tab} isActive={i === 0} />
                ))}
              </div>
            </div>
          </div>
          <div className="accordion-tabs-wrap">
            <div className="grid-cols-2 grid-gap-1-5rem none">
              <div className="grid-col-1 add-ons_js-accordion">
                {TABS.map((tab, i) => (
                  <MobileAccordionItem key={tab.id} tab={tab} index={i} isActive={i === 0} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="bg_blur-main">
        <div className="blur_home animate-pulse"></div>
        <div className="blur_home animate-pulse alt"></div>
        <div className="hide w-embed">
          <style dangerouslySetInnerHTML={{__html: `
.animate-pulse { animation: 2s cubic-bezier(0.4, 0, 0.6, 1) 0s infinite normal none running pulse; }
`}} />
        </div>
      </div>
    </div>
  );
}

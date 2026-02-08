const QUOTES_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 21 24" fill="none" className="quotes_svg">
    <path d="M0 10.125C0 7.03125 2.48438 4.5 5.625 4.5H6C6.79688 4.5 7.5 5.20312 7.5 6C7.5 6.84375 6.79688 7.5 6 7.5H5.625C4.17188 7.5 3 8.71875 3 10.125V10.5H6C7.64062 10.5 9 11.8594 9 13.5V16.5C9 18.1875 7.64062 19.5 6 19.5H3C1.3125 19.5 0 18.1875 0 16.5V15V13.5V10.125ZM12 10.125C12 7.03125 14.4844 4.5 17.625 4.5H18C18.7969 4.5 19.5 5.20312 19.5 6C19.5 6.84375 18.7969 7.5 18 7.5H17.625C16.1719 7.5 15 8.71875 15 10.125V10.5H18C19.6406 10.5 21 11.8594 21 13.5V16.5C21 18.1875 19.6406 19.5 18 19.5H15C13.3125 19.5 12 18.1875 12 16.5V15V13.5V10.125Z" fill="currentColor" />
  </svg>
);

const FEATURE_ICONS = {
  news: (
    <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 40 41" fill="none" className="form_icon">
      <path d="M12 1H28C34.3513 1 39.5 6.14873 39.5 12.5V28.5C39.5 34.8513 34.3513 40 28 40H12C5.64873 40 0.5 34.8513 0.5 28.5V12.5C0.5 6.14873 5.64873 1 12 1Z" fill="url(#paint0_linear_690_23028)" />
      <path d="M12 1H28C34.3513 1 39.5 6.14873 39.5 12.5V28.5C39.5 34.8513 34.3513 40 28 40H12C5.64873 40 0.5 34.8513 0.5 28.5V12.5C0.5 6.14873 5.64873 1 12 1Z" stroke="white" />
      <path d="M23.5 19.5C23.2188 19.5 23 19.2812 23 19V15.5V14C23 13.75 23.2188 13.5 23.5 13.5H26C26.25 13.5 26.5 13.75 26.5 14V15.5C26.5 15.7812 26.25 16 26 16H24V19C24 19.2812 23.75 19.5 23.5 19.5ZM11 19C11 16.5312 13 14.5 15.5 14.5C17.9688 14.5 20 16.5312 20 19V24.5C20 25.625 19.0938 26.5 18 26.5H13C11.875 26.5 11 25.625 11 24.5V19ZM13 19C13 19.2812 13.2188 19.5 13.5 19.5H17.5C17.75 19.5 18 19.2812 18 19C18 18.75 17.75 18.5 17.5 18.5H13.5C13.2188 18.5 13 18.75 13 19Z" fill="#6860FF" />
      <path opacity="0.4" d="M15.5 14.5H23V15.5V19C23 19.2812 23.2188 19.5 23.5 19.5C23.75 19.5 24 19.2812 24 19V16H26C26.25 16 26.5 15.7812 26.5 15.5V14.9688C27.9688 15.7188 29 17.25 29 19V24.5C29 25.625 28.0938 26.5 27 26.5H18C19.0938 26.5 20 25.625 20 24.5V19C20 16.5312 17.9688 14.5 15.5 14.5Z" fill="#6860FF" />
      <defs>
        <linearGradient id="paint0_linear_690_23028" x1="46.4077" y1="-0.711321" x2="0.722083" y2="4.18803" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" />
          <stop offset="1" stopColor="#EEEEFF" />
        </linearGradient>
      </defs>
    </svg>
  ),
  tips: (
    <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 40 41" fill="none" className="form_icon">
      <path d="M12 1H28C34.3513 1 39.5 6.14873 39.5 12.5V28.5C39.5 34.8513 34.3513 40 28 40H12C5.64873 40 0.5 34.8513 0.5 28.5V12.5C0.5 6.14873 5.64873 1 12 1Z" fill="url(#paint0_linear_690_23031)" />
      <path d="M12 1H28C34.3513 1 39.5 6.14873 39.5 12.5V28.5C39.5 34.8513 34.3513 40 28 40H12C5.64873 40 0.5 34.8513 0.5 28.5V12.5C0.5 6.14873 5.64873 1 12 1Z" stroke="white" />
      <path d="M11.6562 12.625L13.1562 13.625C13.5 13.875 13.5938 14.3438 13.375 14.6875C13.125 15.0312 12.6562 15.125 12.3125 14.875L10.8125 13.875C10.4688 13.6562 10.375 13.1875 10.625 12.8438C10.8438 12.5 11.3125 12.4062 11.6562 12.625ZM29.1562 13.875L27.6562 14.875C27.3125 15.125 26.8438 15.0312 26.625 14.6875C26.375 14.3438 26.4688 13.875 26.8125 13.625L28.3125 12.625C28.6562 12.4062 29.125 12.5 29.375 12.8438C29.5938 13.1875 29.5 13.6562 29.1562 13.875ZM10.75 17.5H12.75C13.1562 17.5 13.5 17.8438 13.5 18.25C13.5 18.6875 13.1562 19 12.75 19H10.75C10.3125 19 10 18.6875 10 18.25C10 17.8438 10.3125 17.5 10.75 17.5ZM27.25 17.5H29.25C29.6562 17.5 30 17.8438 30 18.25C30 18.6875 29.6562 19 29.25 19H27.25C26.8125 19 26.5 18.6875 26.5 18.25C26.5 17.8438 26.8125 17.5 27.25 17.5ZM13.1562 22.875L11.6562 23.875C11.3125 24.125 10.8438 24.0312 10.625 23.6875C10.375 23.3438 10.4688 22.875 10.8125 22.625L12.3125 21.625C12.6562 21.4062 13.125 21.5 13.375 21.8438C13.5938 22.1875 13.5 22.6562 13.1562 22.875ZM27.6562 21.6562L29.1562 22.6562C29.5 22.875 29.5938 23.3438 29.375 23.6875C29.125 24.0312 28.6562 24.125 28.3125 23.9062L26.8125 22.9062C26.4688 22.6562 26.375 22.1875 26.625 21.8438C26.8438 21.5 27.3125 21.4062 27.6562 21.6562ZM17 25.5C17 24.9688 17.4375 24.5 18 24.5H22C22.5312 24.5 23 24.9688 23 25.5V26.5C23 27.0625 22.5312 27.5 22 27.5H21C21 28.0625 20.5312 28.5 20 28.5C19.4375 28.5 19 28.0625 19 27.5H18C17.4375 27.5 17 27.0625 17 26.5V25.5Z" fill="#6860FF" />
      <path opacity="0.4" d="M15 14.5C15 14.0625 15.2812 13.6562 15.75 13.5312L19.75 12.5312C20.2812 12.4062 20.8125 12.75 20.9688 13.2812C21.0938 13.8125 20.75 14.3438 20.2188 14.5L16.2188 15.5C15.6875 15.625 15.1562 15.2812 15.0312 14.75C15 14.6875 15 14.5938 15 14.5ZM15 17.5C15 17.0625 15.2812 16.6562 15.75 16.5312L23.75 14.5312C24.2812 14.4062 24.8125 14.75 24.9688 15.2812C25.0938 15.8125 24.75 16.3438 24.2188 16.5L16.2188 18.5C15.6875 18.625 15.1562 18.2812 15.0312 17.75C15 17.6875 15 17.5938 15 17.5ZM15 20.5C15 20.0625 15.2812 19.6562 15.75 19.5312L23.75 17.5312C24.2812 17.4062 24.8125 17.75 24.9688 18.2812C25.0938 18.8125 24.75 19.3438 24.2188 19.4688L18.0938 21L18 21.0312L16.2188 21.5C15.6875 21.625 15.1562 21.2812 15.0312 20.75C15 20.6875 15 20.5938 15 20.5ZM18 22.0625L19.5 21.6875V24.5H18V22.0625ZM20.5 22C20.5312 21.625 20.8438 21.2812 21.25 21.1562L21.75 21.0312L23.75 20.5312C24.2812 20.4062 24.8125 20.75 24.9688 21.2812C25.0938 21.8125 24.75 22.3438 24.2188 22.5L22.2188 23L22 23.0312V24.5H20.5V22.1562V22.125C20.5 22.0938 20.5 22.0625 20.5 22Z" fill="#6860FF" />
      <defs>
        <linearGradient id="paint0_linear_690_23031" x1="46.4077" y1="-0.711321" x2="0.722083" y2="4.18803" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" />
          <stop offset="1" stopColor="#EEEEFF" />
        </linearGradient>
      </defs>
    </svg>
  ),
  noSpam: (
    <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 40 41" fill="none" className="form_icon">
      <path d="M12 1H28C34.3513 1 39.5 6.14873 39.5 12.5V28.5C39.5 34.8513 34.3513 40 28 40H12C5.64873 40 0.5 34.8513 0.5 28.5V12.5C0.5 6.14873 5.64873 1 12 1Z" fill="url(#paint0_linear_690_23034)" />
      <path d="M12 1H28C34.3513 1 39.5 6.14873 39.5 12.5V28.5C39.5 34.8513 34.3513 40 28 40H12C5.64873 40 0.5 34.8513 0.5 28.5V12.5C0.5 6.14873 5.64873 1 12 1Z" stroke="white" />
      <path d="M25.5 19.5H26.5C26.75 19.5 27 19.75 27 20V21C27 21.2812 26.75 21.5 26.5 21.5H25.5C25.2188 21.5 25 21.2812 25 21V20C25 19.75 25.2188 19.5 25.5 19.5ZM11 21.5C11 20.9688 11.4375 20.5 12 20.5H20C20.5312 20.5 21 20.9688 21 21.5V21.9062L16.125 25.5C16.0938 25.5312 16.0312 25.5625 16 25.5625C15.9375 25.5625 15.875 25.5312 15.8438 25.5L11 21.9062V21.5ZM16.75 26.3125L21 23.1562V27.5C21 28.0625 20.5312 28.5 20 28.5H12C11.4375 28.5 11 28.0625 11 27.5V23.1562L15.25 26.3125C15.4375 26.4688 15.7188 26.5625 16 26.5625C16.25 26.5625 16.5312 26.4688 16.75 26.3125Z" fill="#6860FF" />
      <path opacity="0.4" d="M11 21.9062C12.5938 23.125 14.2188 24.3125 15.8438 25.5C15.875 25.5312 15.9375 25.5625 16 25.5625C16.0312 25.5625 16.0938 25.5312 16.125 25.5C17.75 24.3125 19.375 23.125 21 21.9062V23.1562L16.75 26.3125C16.5312 26.4688 16.25 26.5625 16 26.5625C15.7188 26.5625 15.4375 26.4688 15.25 26.3125L11 23.1562V21.9062ZM13 13.5C13 12.9688 13.4375 12.5 14 12.5H24C24.5312 12.5 25 12.9688 25 13.5V16.5H18C16.875 16.5 16 17.4062 16 18.5V19.5H13V13.5ZM17 18.5C17 17.9688 17.4375 17.5 18 17.5H28C28.5312 17.5 29 17.9688 29 18.5V24.5C29 25.0625 28.5312 25.5 28 25.5H22V21.5C22 20.4062 21.0938 19.5 20 19.5H17V18.5ZM25 20V21C25 21.2812 25.2188 21.5 25.5 21.5H26.5C26.75 21.5 27 21.2812 27 21V20C27 19.75 26.75 19.5 26.5 19.5H25.5C25.2188 19.5 25 19.75 25 20Z" fill="#6860FF" />
      <defs>
        <linearGradient id="paint0_linear_690_23034" x1="46.4077" y1="-0.711321" x2="0.722083" y2="4.18803" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" />
          <stop offset="1" stopColor="#EEEEFF" />
        </linearGradient>
      </defs>
    </svg>
  ),
};

const CTA_FEATURES = [
  { icon: FEATURE_ICONS.news, text: "Latest AI news, tips, and techniques" },
  { icon: FEATURE_ICONS.tips, text: "Specific tips for Your AI use cases" },
  { icon: FEATURE_ICONS.noSpam, text: "No spam" },
];

const TESTIMONIALS = [
  {
    quote: "Each issue is packed with valuable resources, tools, and insights that help us stay ahead in AI development. We've discovered strategies and frameworks that boosted our efficiency by 30%, making it a must-read for anyone in the field.",
    name: "Marina Trajkovska",
    role: "Head of Engineering",
    logo: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/67054ff3cd8d0a6dcdb69790_odyseek-logo.avif",
  },
  {
    quote: "This is just a great newsletter. The content is so helpful, even when I'm busy I read them.",
    name: "Jeremy Hicks",
    role: "Solutions Architect",
    logo: "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6706876bf08578fa9b00cad4_image%201728072179.webp",
  },
];

const FRAME_SVG = (
  <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 700 561" fill="none" className="cta_frame_small">
    <line x1="650.5" y1="0.863281" x2="650.5" y2="560.863" stroke="url(#paint0_linear_690_2)" />
    <line x1="662.5" y1="0.863281" x2="662.5" y2="560.863" stroke="url(#paint1_linear_690_2)" />
    <line x1="38.5" y1="0.863281" x2="38.5" y2="560.863" stroke="url(#paint2_linear_690_2)" />
    <line x1="50.5" y1="0.863281" x2="50.5" y2="560.863" stroke="url(#paint3_linear_690_2)" />
    <line x1="700" y1="82" x2="0" y2="81.9999" stroke="url(#paint4_linear_690_2)" />
    <line x1="700" y1="94" x2="0" y2="93.9999" stroke="url(#paint5_linear_690_2)" />
    <line x1="700" y1="467.5" x2="0" y2="467.5" stroke="url(#paint6_linear_690_2)" />
    <line x1="700" y1="479.5" x2="0" y2="479.5" stroke="url(#paint7_linear_690_2)" />
    <defs>
      <linearGradient id="paint0_linear_690_2" x1="649.929" y1="0.863283" x2="644.282" y2="0.903029" gradientUnits="userSpaceOnUse">
        <stop stopColor="#DFDBF3" />
        <stop offset="1" stopColor="#D8C8D9" />
      </linearGradient>
      <linearGradient id="paint1_linear_690_2" x1="661.929" y1="0.863283" x2="656.282" y2="0.903029" gradientUnits="userSpaceOnUse">
        <stop stopColor="#DFDBF3" />
        <stop offset="1" stopColor="#D8C8D9" />
      </linearGradient>
      <linearGradient id="paint2_linear_690_2" x1="37.9292" y1="0.863283" x2="32.2818" y2="0.903029" gradientUnits="userSpaceOnUse">
        <stop stopColor="#DFDBF3" />
        <stop offset="1" stopColor="#D8C8D9" />
      </linearGradient>
      <linearGradient id="paint3_linear_690_2" x1="49.9292" y1="0.863283" x2="44.2818" y2="0.903029" gradientUnits="userSpaceOnUse">
        <stop stopColor="#DFDBF3" />
        <stop offset="1" stopColor="#D8C8D9" />
      </linearGradient>
      <linearGradient id="paint4_linear_690_2" x1="700" y1="81.4291" x2="699.968" y2="75.7817" gradientUnits="userSpaceOnUse">
        <stop stopColor="#DFDBF3" />
        <stop offset="1" stopColor="#D8C8D9" />
      </linearGradient>
      <linearGradient id="paint5_linear_690_2" x1="700" y1="93.4291" x2="699.968" y2="87.7817" gradientUnits="userSpaceOnUse">
        <stop stopColor="#DFDBF3" />
        <stop offset="1" stopColor="#D8C8D9" />
      </linearGradient>
      <linearGradient id="paint6_linear_690_2" x1="700" y1="466.929" x2="699.968" y2="461.282" gradientUnits="userSpaceOnUse">
        <stop stopColor="#DFDBF3" />
        <stop offset="1" stopColor="#D8C8D9" />
      </linearGradient>
      <linearGradient id="paint7_linear_690_2" x1="700" y1="478.929" x2="699.968" y2="473.282" gradientUnits="userSpaceOnUse">
        <stop stopColor="#DFDBF3" />
        <stop offset="1" stopColor="#D8C8D9" />
      </linearGradient>
    </defs>
  </svg>
);

function TestimonialCard({ quote, name, role, logo }: typeof TESTIMONIALS[number]) {
  return (
    <div className="testimonial_card">
      <div className="testimonial_card_head">
        {QUOTES_ICON}
        <div className="u-hflex-left-bottom">
          <p className="u-text-regular is--small">
            <em>{quote}</em>
          </p>
          {QUOTES_ICON}
        </div>
      </div>
      <div className="testimonial_card_body u-hflex-between-center">
        <div className="u-hflex-center-center gap-small">
          <div>
            <div className="author_name">{name}</div>
            <div className="author_role">{role}</div>
          </div>
        </div>
        <img loading="lazy" src={logo} alt="" className="testimonial_card_logo" />
      </div>
    </div>
  );
}

export function BlogCTA() {
  return (
    <section className="gradient-cta">
      <div className="u-container is--cta">
        <div className="u-hflex-left-center gap-medium">
          <div className="cta_frame_wrap u-hflex-center-center is--small">
            <div className="cta_form_block is--small w-form">
              <div className="u-vflex-stretch-top gap-medium">
                <div className="cta_form_heading is--small">
                  The Best AI Tips — Direct To Your Inbox
                </div>
                <div className="cta_form_features u-vflex-stretch-top gap-small">
                  {CTA_FEATURES.map((feature) => (
                    <div key={feature.text} className="u-hflex-left-center gap-xsmall">
                      {feature.icon}
                      <p className="form_text">{feature.text}</p>
                    </div>
                  ))}
                </div>
              </div>
              <form
                id="wf-form-Newsletter"
                name="wf-form-Newsletter"
                data-name="Newsletter"
                method="get"
                className="cta_form u-vflex-stretch-top gap-form"
              >
                <div className="u-hflex-between-stretch gap-cta">
                  <div className="u-hflex-left-center gap-cta">
                    <input
                      className="cta_text_field is--cta-small w-input"
                      maxLength={256}
                      name="email"
                      data-name="email"
                      placeholder="john@startup.com"
                      type="email"
                      id="email"
                      required
                    />
                    <input
                      type="submit"
                      data-wait=""
                      className="button_main is--cta w-button"
                      value="Join Newsletter"
                    />
                  </div>
                </div>
              </form>
              <div className="cta_form_success is--newsletter w-form-done">
                <div>Thank you! Your submission has been received!</div>
              </div>
              <div className="w-form-fail">
                <div>Oops! Something went wrong while submitting the form.</div>
              </div>
            </div>
            {FRAME_SVG}
          </div>
          <div className="u-vflex-left-top cta-testimonials">
            {TESTIMONIALS.map((testimonial) => (
              <TestimonialCard key={testimonial.name} {...testimonial} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

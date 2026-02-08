/**
 * LogoMarquee Component
 *
 * Extracted from vellum-homepage.html (Phase 2)
 * - Client logos scrolling section
 * - "Trusted by companies of all sizes" header
 * - Logo marquee with company logos
 *
 * All Webflow classes and fs-marquee attributes preserved for animations.
 */

import Image from "next/image";

export function LogoMarquee() {
  // Sample logos - in production this would be dynamic
  const logos = [
    { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68cb1408ea000f101ee4ad31_logo-rentgrata%20(1).avif", alt: "RentGrata", caseStudy: "/blog/rentgrata-production-chatbot-vellum", hasCaseStudy: true },
    { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68598cd9be9527709d12f725_logo-drata.avif", alt: "Drata", caseStudy: "/blog/how-drata-built-an-enterprise-grade-ai-solution-with-vellum", hasCaseStudy: true },
    { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/681a3329205dec65325445ab_deep.avif", alt: "DeepScribe", caseStudy: "/blog/how-deepscribe-builds-clinician-trust-by-iterating-on-ai-feedback-40-faster", hasCaseStudy: true },
    { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68598d3ccdd0c82f41c84eed_logo-redfin.avif", alt: "Redfin", caseStudy: "/blog/redfins-test-driven-development-approach-to-building-an-ai-virtual-assistant", hasCaseStudy: true },
    { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/685aedfc332b150e2f36290f_logo-lavender.avif", alt: "Lavender", caseStudy: "/blog/how-lavender-cut-latency-by-half-for-90k-monthly-requests-in-production", hasCaseStudy: true },
    { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/685a0f40aa663e0596d22066_logo-health.avif", alt: "Rely Health", caseStudy: "/blog/how-relyhealth-deploys-healthcare-ai-solutions-faster-with-vellum", hasCaseStudy: true },
    { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68598cfe64b89ea54689217a_logo-gstack.avif", alt: "GravityStack", caseStudy: "/blog/how-gravitystack-cut-credit-agreement-review-time-by-200-with-agentic-ai", hasCaseStudy: true },
    { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68c9ae606fadce878f8d7956_logo-coursemojo%20(1).avif", alt: "CourseMojo", caseStudy: "/blog/coursemojo-case-study", hasCaseStudy: true },
  ];

  return (
    <div className="section-logo new">
      <div className="padding-global new">
        <div className="container-new new logo">
          <div className="content-main no-padding no-bg">
            <div className="logo_main-wrapper">
              <div className="tab_main-comp">
                <div className="tab_header-main">
                  <div className="trusted_header hide">Trusted by </div>
                </div>
                <div 
                  data-fs-marquee-type="cms" 
                  data-fs-marquee-element="marquee" 
                  data-fs-marquee-instance="fs--logo-marquee" 
                  className="fs-logo-marquee_instance"
                >
                  <div className="div-block-238">
                    <div className="trusted_header align-center">Trusted by companies of all sizes</div>
                  </div>
                  <div data-fade="" data-fs-marquee-element="wrapper" className="fs-logo-marquee_list-wrapper alt w-dyn-list">
                    <div data-fs-marquee-element="list" role="list" className="fs-logo-marquee_list w-dyn-items" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "3rem", flexWrap: "nowrap", padding: "1.5rem 0" }}>
                      {logos.map((logo, index) => (
                        <div key={index} data-fs-marquee-element="item" role="listitem" className="logo_item pill w-dyn-item" style={{ position: "relative", flexShrink: 0 }}>
                          <Image loading="lazy" src={logo.src} alt={logo.alt} className="marquee_logo smaller" width={150} height={40} unoptimized style={{ height: "28px", width: "auto", objectFit: "contain", opacity: 0.8 }} />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="underline_border"></div>
        </div>
      </div>
    </div>
  );
}

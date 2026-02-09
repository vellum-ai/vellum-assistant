import Image from "next/image";

const logos = [
  { src: "/logos/marquee/ash.png", alt: "Ash" },
  { src: "/logos/marquee/brailliant.svg", alt: "Brailliant" },
  { src: "/logos/marquee/conver.avif", alt: "Conver" },
  { src: "/logos/marquee/coursemojo.avif", alt: "CourseMojo" },
  { src: "/logos/marquee/crowe.avif", alt: "Crowe" },
  { src: "/logos/marquee/deepscribe.avif", alt: "DeepScribe" },
  { src: "/logos/marquee/drata.png", alt: "Drata" },
  { src: "/logos/marquee/fastweb.png", alt: "Fastweb" },
  { src: "/logos/marquee/gns.png", alt: "GNS" },
  { src: "/logos/marquee/gravitystack.png", alt: "GravityStack" },
  { src: "/logos/marquee/headspace.png", alt: "Headspace" },
  { src: "/logos/marquee/invisible.png", alt: "Invisible" },
  { src: "/logos/marquee/lavender.png", alt: "Lavender" },
  { src: "/logos/marquee/left-field-labs.png", alt: "Left Field Labs" },
  { src: "/logos/marquee/ogilvy.avif", alt: "Ogilvy" },
  { src: "/logos/marquee/redfin.png", alt: "Redfin" },
  { src: "/logos/marquee/rely-health.png", alt: "Rely Health" },
  { src: "/logos/marquee/rentgrata.avif", alt: "RentGrata" },
  { src: "/logos/marquee/ro.avif", alt: "Ro" },
  { src: "/logos/marquee/seeking-alpha.png", alt: "Seeking Alpha" },
  { src: "/logos/marquee/swisscom.png", alt: "Swisscom" },
];

export function LogoMarquee() {
  return (
    <div className="section-logo new">
      <style>{`
        @keyframes logo-marquee-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
      <div className="padding-global new">
        <div className="container-new new logo">
          <div className="content-main no-padding no-bg">
            <div className="logo_main-wrapper">
              <div className="tab_main-comp">
                <div className="tab_header-main">
                  <div className="trusted_header hide">Trusted by </div>
                </div>
                <div className="fs-logo-marquee_instance">
                  <div className="div-block-238">
                    <div className="trusted_header align-center">Trusted by companies of all sizes</div>
                  </div>
                  <div className="fs-logo-marquee_list-wrapper alt w-dyn-list" style={{ overflow: "hidden", maskImage: "linear-gradient(to right, transparent, black 10%, black 90%, transparent)", WebkitMaskImage: "linear-gradient(to right, transparent, black 10%, black 90%, transparent)" }}>
                    <div role="list" className="fs-logo-marquee_list w-dyn-items" style={{ display: "flex", alignItems: "center", gap: "3rem", flexWrap: "nowrap", padding: "1.5rem 0", width: "max-content", animation: "logo-marquee-scroll 30s linear infinite" }}>
                      {[...logos, ...logos].map((logo, index) => (
                        <div key={index} role="listitem" className="logo_item pill w-dyn-item" style={{ flexShrink: 0 }}>
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

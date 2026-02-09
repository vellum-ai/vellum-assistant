import Image from "next/image";

const logos = [
  { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68cb1408ea000f101ee4ad31_logo-rentgrata%20(1).avif", alt: "RentGrata" },
  { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68598cd9be9527709d12f725_logo-drata.avif", alt: "Drata" },
  { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/681a3329205dec65325445ab_deep.avif", alt: "DeepScribe" },
  { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68598d3ccdd0c82f41c84eed_logo-redfin.avif", alt: "Redfin" },
  { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/685aedfc332b150e2f36290f_logo-lavender.avif", alt: "Lavender" },
  { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/685a0f40aa663e0596d22066_logo-health.avif", alt: "Rely Health" },
  { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68598cfe64b89ea54689217a_logo-gstack.avif", alt: "GravityStack" },
  { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68c9ae606fadce878f8d7956_logo-coursemojo%20(1).avif", alt: "CourseMojo" },
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
                    <div role="list" className="fs-logo-marquee_list w-dyn-items" style={{ display: "flex", alignItems: "center", gap: "3rem", flexWrap: "nowrap", padding: "1.5rem 0", width: "max-content", animation: "logo-marquee-scroll 20s linear infinite" }}>
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

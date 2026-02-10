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
    <div 
      style={{
        background: "rgba(255, 255, 255, 0.1)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderTop: "1px solid rgba(255, 255, 255, 0.15)",
        padding: "0.5rem 0",
      }}
    >
      <style>{`
        @keyframes logo-marquee-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
      <div style={{ textAlign: "center", marginBottom: "0.25rem" }}>
        <span style={{ color: "rgba(255, 255, 255, 0.8)", fontSize: "0.75rem" }}>Used by people who value their time</span>
      </div>
      <div style={{ overflow: "hidden", maskImage: "linear-gradient(to right, transparent, black 10%, black 90%, transparent)", WebkitMaskImage: "linear-gradient(to right, transparent, black 10%, black 90%, transparent)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "2rem", flexWrap: "nowrap", padding: "0.25rem 0", width: "max-content", animation: "logo-marquee-scroll 30s linear infinite" }}>
          {[...logos, ...logos].map((logo, index) => (
            <div key={index} style={{ flexShrink: 0 }}>
              <Image loading="lazy" src={logo.src} alt={logo.alt} width={100} height={20} unoptimized style={{ height: "16px", width: "auto", objectFit: "contain", opacity: 0.8, filter: "brightness(0) invert(1)" }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

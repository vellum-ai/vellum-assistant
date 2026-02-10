import { Footer } from "./Footer";
import { HeroSection } from "./HeroSection";
import { LogoMarquee } from "./LogoMarquee";
import { NavBar } from "./NavBar";

export function VellumBody() {
  return (
    <>
      {/* Hero wrapper - always 100vh */}
      <div
        style={{
          height: "100vh",
          minHeight: "100vh",
          backgroundImage: "url('/hero-bg.jpg')",
          backgroundSize: "cover",
          backgroundPosition: "center 30%",
          backgroundRepeat: "no-repeat",
          backgroundColor: "#3a8bc2",
          position: "relative",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Dark overlay for text readability - z-index 1 */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.35)",
            zIndex: 1,
            pointerEvents: "none",
          }}
        />
        {/* Content wrapper - z-index 2, above overlay */}
        <div
          style={{
            position: "relative",
            zIndex: 2,
            display: "flex",
            flexDirection: "column",
            flex: 1,
          }}
        >
          <NavBar />
          <HeroSection />
          <LogoMarquee />
        </div>
      </div>
      <Footer />
    </>
  );
}

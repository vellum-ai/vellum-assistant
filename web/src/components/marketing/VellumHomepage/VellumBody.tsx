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
          backgroundPosition: "center bottom",
          backgroundRepeat: "no-repeat",
          backgroundColor: "#3a8bc2",
          position: "relative",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Subtle gradient overlay for text readability - z-index 1 */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(to bottom, rgba(0, 0, 0, 0.1) 0%, rgba(0, 0, 0, 0.25) 50%, rgba(0, 0, 0, 0.35) 100%)",
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

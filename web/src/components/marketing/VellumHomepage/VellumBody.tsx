import { Footer } from "./Footer";
import { HeroSection } from "./HeroSection";
import { LogoMarquee } from "./LogoMarquee";
import { NavBar } from "./NavBar";

export function VellumBody() {
  return (
    <div style={{ position: "relative" }}>
      <NavBar />
      <HeroSection />
      <LogoMarquee />
      <Footer />
    </div>
  );
}

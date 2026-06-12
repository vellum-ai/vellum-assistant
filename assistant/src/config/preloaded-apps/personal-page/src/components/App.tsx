import { profile } from "../profile-data";
import { About } from "./About";
import { Features } from "./Features";
import { Hero } from "./Hero";
import { Pending } from "./Pending";

export function App() {
  if (profile.status !== "ready") return <Pending />;
  return (
    <main>
      <Hero />
      <About />
      <Features />
    </main>
  );
}

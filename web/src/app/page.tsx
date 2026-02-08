import fs from "fs/promises";
import path from "path";

export default async function Home() {
  // Read the vellum.ai homepage HTML
  const htmlPath = path.join(process.cwd(), "public", "vellum-homepage.html");
  const htmlContent = await fs.readFile(htmlPath, "utf-8");

  // Return the HTML exactly as it appears on vellum.ai
  return <div dangerouslySetInnerHTML={{ __html: htmlContent }} />;
}

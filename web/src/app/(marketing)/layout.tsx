import { VellumHead } from "@/components/marketing/VellumHomepage";

import "./marketing.css";

export default function MarketingLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="marketing-root">
      <VellumHead />
      {children}
    </div>
  );
}

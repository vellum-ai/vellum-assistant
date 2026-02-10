"use client";

import { useEffect } from "react";
import Script from "next/script";

const WEBFLOW_CSS_HREF =
  "https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/css/vellum-v2.webflow.shared.8974b486a.min.css";
const WEBFLOW_CSS_INTEGRITY =
  "sha384-iXS0hqh2XhV4cggyxfyByEBXc6zfb+ifhTIGKjaf4dzNqrxjku3vwiVZ925Mf7Ef";
const WEBFLOW_LINK_ID = "webflow-css";

export function VellumHead() {
  useEffect(() => {
    if (document.getElementById(WEBFLOW_LINK_ID)) {
      return;
    }

    const link = document.createElement("link");
    link.id = WEBFLOW_LINK_ID;
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = WEBFLOW_CSS_HREF;
    link.integrity = WEBFLOW_CSS_INTEGRITY;
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);

    return () => {
      document.getElementById(WEBFLOW_LINK_ID)?.remove();
    };
  }, []);

  return (
    <>
      {/* Google Fonts */}
      <link href="https://fonts.googleapis.com" rel="preconnect" />
      <link
        href="https://fonts.gstatic.com"
        rel="preconnect"
        crossOrigin="anonymous"
      />

      {/* WebFont Loader */}
      <Script
        src="https://ajax.googleapis.com/ajax/libs/webfont/1.6.26/webfont.js"
        strategy="afterInteractive"
        onReady={() => {
          (window as unknown as { WebFont: { load: (config: { google: { families: string[] } }) => void } }).WebFont.load({
            google: {
              families: [
                "Montserrat:100,100italic,200,200italic,300,300italic,400,400italic,500,500italic,600,600italic,700,700italic,800,800italic,900,900italic",
                "Lato:100,100italic,300,300italic,400,400italic,700,700italic,900,900italic",
                "Inter:300,400,500,600,700",
                "Playfair Display:300,400,500,600,700",
              ],
            },
          });
        }}
      />

      {/* Webflow Modernizr */}
      <Script id="webflow-modernizr" strategy="afterInteractive">
        {`
          !function(o,c){
            var n=c.documentElement,t=" w-mod-";
            n.className+=t+"js",
            ("ontouchstart"in o||o.DocumentTouch&&c instanceof DocumentTouch)&&
            (n.className+=t+"touch")
          }(window,document);
        `}
      </Script>
    </>
  );
}

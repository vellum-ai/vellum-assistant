"use client";

import Script from "next/script";
import { useEffect, useSyncExternalStore } from "react";

const PRODUCTION_HOSTNAMES = ["www.vellum.ai", "vellum.ai", "assistant.vellum.ai", "www.assistant.vellum.ai"];

function getIsProduction() {
  return PRODUCTION_HOSTNAMES.includes(window.location.hostname);
}

function subscribe() {
  return () => {};
}

export function VellumScripts() {
  const isProduction = useSyncExternalStore(subscribe, getIsProduction, () => false);

  useEffect(() => {
    window.dataLayer = window.dataLayer || [];
  }, []);

  return (
    <>
      {isProduction && (
        <>
          {/* Google Analytics */}
          <Script
            src="https://www.googletagmanager.com/gtag/js?id=G-PDKD1Q02E2"
            strategy="afterInteractive"
          />
          <Script id="google-analytics" strategy="afterInteractive">
            {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('set', 'developer_id.dZGVlNj', true);
              gtag('js', new Date());
              gtag('config', 'G-PDKD1Q02E2');
            `}
          </Script>

          {/* Google Tag Manager */}
          <Script id="google-tag-manager" strategy="afterInteractive">
            {`
              (function(w,d,s,l,i){
                w[l]=w[l]||[];
                w[l].push({'gtm.start': new Date().getTime(),event:'gtm.js'});
                var f=d.getElementsByTagName(s)[0],
                j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';
                j.async=true;
                j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;
                f.parentNode.insertBefore(j,f);
              })(window,document,'script','dataLayer','GTM-KFKFCZV6');
            `}
          </Script>

          {/* Webflow Currency Settings */}
          <Script id="webflow-currency" strategy="afterInteractive">
            {`
              window.__WEBFLOW_CURRENCY_SETTINGS = {
                "currencyCode":"USD",
                "symbol":"$",
                "decimal":".",
                "fractionDigits":2,
                "group":",",
                "template":"{{wf {\\"path\\":\\"symbol\\",\\"type\\":\\"PlainText\\"} }} {{wf {\\"path\\":\\"amount\\",\\"type\\":\\"CommercePrice\\"} }} {{wf {\\"path\\":\\"currencyCode\\",\\"type\\":\\"PlainText\\"} }}",
                "hideDecimalForWholeNumbers":false
              };
            `}
          </Script>

          {/* CleverTap Signals */}
          <Script id="clevertap-signals" strategy="afterInteractive">
            {`
              (function() {
                if (typeof window === 'undefined') return;
                if (typeof window.signals !== 'undefined') return;
                var script = document.createElement('script');
                script.src = 'https://cdn.cr-relay.com/v1/site/64388303-58a5-4a26-a0cf-f6b295bc4c3b/signals.js';
                script.async = true;
                window.signals = Object.assign(
                  [],
                  ['page', 'identify', 'form'].reduce(function (acc, method){
                    acc[method] = function () {
                      signals.push([method, arguments]);
                      return signals;
                    };
                   return acc;
                  }, {})
                );
                document.head.appendChild(script);
              })();
            `}
          </Script>

          {/* Athena Telemetry */}
          <Script id="athena-telemetry" strategy="afterInteractive">
            {`
              (function() {
                window.athenaTelemetryQueue = window.athenaTelemetryQueue || [];
                
                var script = document.createElement('script');
                script.async = true;
                script.src = 'https://app.athenahq.ai/api/tracking/91660509-34da-45d1-ab12-daae57572117';
                
                var firstScript = document.getElementsByTagName('script')[0];
                if (firstScript && firstScript.parentNode) {
                  firstScript.parentNode.insertBefore(script, firstScript);
                } else {
                  document.head.appendChild(script);
                }
              })();
            `}
          </Script>

          {/* Positional Config */}
          <Script id="positional-config" strategy="afterInteractive">
            {`
              window.__positional_config = {
                customerId: "9309975e-cd4d-4392-b468-93e78f92cba3",
              };
            `}
          </Script>
        </>
      )}

    </>
  );
}

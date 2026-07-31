import { DocsContent } from "@/app/docs/_components/docs-content";
import { createMetadata } from "@/lib/metadata";
import { routes } from "@/lib/routes";

export const metadata = createMetadata({
  title: "Privacy Notice - Vellum",
  description:
    "Vellum's privacy notice explaining how we collect, use, disclose and otherwise process your information.",
  path: routes.docs.legal.privacyPolicy,
});

export default function PrivacyPolicyPage() {
  return (
    <DocsContent title="Privacy Notice" breadcrumb="Docs / Legal / Privacy">
                  <p>
                    <em>Last Updated: June 22, 2026</em>
                  </p>
                  <p>
                    This Privacy Notice describes how Vocify, Inc., the provider of Vellum (collectively, &quot;<strong><em>Vellum</em></strong>,&quot; &quot;<strong><em>we</em></strong>,&quot; or &quot;<strong><em>us</em></strong>&quot;), collects, uses, discloses and otherwise processes information we collect when you access or use our websites (collectively, the &quot;<strong><em>Website</em></strong>&quot;) or applications (the &quot;<strong><em>Services</em></strong>&quot;), or when you otherwise interact with us, such as through our customer support channels.
                  </p>
                  <p>
                    This Privacy Notice is effective as of the &quot;Last Updated&quot; date above. We may change this Privacy Notice from time to time. If we make changes, we will notify you by revising the &quot;Last Updated&quot; date. Where required by law, we will notify you of changes through the Website, Services, or by other means.
                  </p>

                  <h2>Collection of Information</h2>

                  <h3>
                    Information You Provide to Us
                  </h3>
                  <p>
                    We collect information directly from you when you visit the Website, download the Services, create an account, request customer support, or otherwise communicate with us. The categories of information we collect include:
                  </p>
                  <ul>
                    <li><strong>Contact Information:</strong> we collect your name and email address.</li>
                    <li><strong>Financial Information:</strong> we rely on third-party payment processors to collect the financial information used to pay for the Services.</li>
                    <li><strong>Communication Information:</strong> we collect information included in your communications with us. For example, the Services include a &quot;send logs&quot; feature that allows you to share logs about bugs, crashes, and the like with our customer support team.</li>
                  </ul>
                  <p>
                    We may also collect any other information you choose to provide.
                  </p>

                  <h3>
                    Information We Collect Automatically
                  </h3>
                  <p>
                    We automatically collect the following categories of information:
                  </p>
                  <ul>
                    <li><strong>Transactional Information:</strong> we keep a history of your transactions with us, including the dates and amounts paid for the Services.</li>
                    <li><strong>Telemetry Information:</strong> consistent with your preferences, we collect telemetry information about your use of the Services, including usage analytics (token counts and feature adoption) and crash diagnostics.</li>
                    <li><strong>Internet Activity Information:</strong> we collect information about how you access our Website, including data about the device and network you use, such as your hardware model, operating system version, mobile network, IP address, unique device identifiers, and browser type. We also collect information about your activity on our Website and interaction with our communications, such as access times, browsing behavior (such as pages viewed and links clicked), and the page you visited before navigating to our Website. When you submit forms (such as waitlist sign-ups or download/access-code requests), we automatically log contextual details about the submission, including the page URL and path, timestamp, referrer/source, and related campaign parameters to attribute the submission to its source. We also record campaign attribution data to understand how you arrived at our website, including UTM parameters, click identifiers, and referrer/source context.</li>
                    <li><strong>Information Collected by Cookies and Similar Tracking Technologies:</strong> We use tracking technologies, such as cookies and pixels to collect information about your interactions with our Website and communications. These technologies help us improve our Website and communications, see which areas and features are popular, count visits, and track clicks. You may be able to adjust your browser settings to remove or reject browser cookies. Please note that removing or rejecting cookies could affect the availability and functionality of our Services.</li>
                    <li><strong>Conversational Content:</strong> consistent with your preferences, we collect the content of your conversations, including the messages and files you send to the model provider and the responses generated for you, and use it to improve the quality and accuracy of our Services, including evaluating and improving the systems that power Vellum, but do not use it to train AI models. You can opt in or out of this collection at any time during onboarding or in Settings &gt; Permissions & Privacy. This is separate from how third-party model providers handle your data, described under the &quot;Third-Party AI Providers&quot; section below.</li>
                  </ul>

                  <h3>
                    Information We Collect from Other Sources
                  </h3>
                  <p>
                    We obtain information from other sources. For example, if you create or log into your Vellum account through a third-party platform (such as Apple or Google), we may have access to certain information from that platform, such as your name and email address, depending on your platform settings. We may also collect information you share when you interact with us on social media platforms.
                  </p>

                  <h3>
                    Derived Information
                  </h3>
                  <p>
                    We may derive information or draw inferences about you based on the information we collect. For example, we may make inferences about your approximate location based on your IP address.
                  </p>

                  <h3>
                    Third-Party AI Providers
                  </h3>
                  <p>
                    The Vellum Assistant uses third-party AI providers to generate responses, transcribe and synthesize speech, search the web, create images, and perform other AI-powered tasks. When you use these features, the relevant inputs, including but not limited to the content of your message, any files you attach, and the surrounding conversation context, are transmitted to the third-party provider that performs the task. Each provider operates under its own privacy notice.
                  </p>
                  <p>In all cases, Vellum may provide Services used to interface with one or more third-party AI providers, and/or allow you to configure your own connections to third-party AI providers using your own credentials.</p>
                  <p>If you use Vellum&apos;s managed Services, Vellum may route your data to any one of the third-party AI providers specified below using Vellum-owned credentials.</p>
                  <p>If you configure your own connection to a third-party AI provider through Vellum, then your data is sent directly to that provider using your credentials and is governed by the terms of your relationship with that provider.</p>
                  <p>
                    <strong>Provider privacy notices.</strong> Below is a list of all third-party AI providers potentially used by Vellum managed Services, as well as their privacy policies. Please review each provider&apos;s privacy notice to understand how they handle your data:
                  </p>
                  <ul>
                    <li>Anthropic: <a href="https://www.anthropic.com/legal/privacy" target="_blank" rel="noreferrer">anthropic.com/legal/privacy</a></li>
                    <li>OpenAI: <a href="https://openai.com/policies/privacy-policy/" target="_blank" rel="noreferrer">openai.com/policies/privacy-policy</a></li>
                    <li>Google: <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">policies.google.com/privacy</a></li>
                    <li>Fireworks AI: <a href="https://fireworks.ai/privacy-policy" target="_blank" rel="noreferrer">fireworks.ai/privacy-policy</a></li>
                    <li>Baseten: <a href="https://www.baseten.co/privacy-policy/" target="_blank" rel="noreferrer">baseten.co/privacy-policy</a></li>
                    <li>Atlas Cloud: <a href="https://www.atlascloud.ai/privacy" target="_blank" rel="noreferrer">atlascloud.ai/privacy</a></li>
                    <li>Together AI: <a href="https://www.together.ai/privacy" target="_blank" rel="noreferrer">together.ai/privacy</a></li>
                    <li>ElevenLabs: <a href="https://elevenlabs.io/privacy-policy" target="_blank" rel="noreferrer">elevenlabs.io/privacy-policy</a></li>
                    <li>Deepgram: <a href="https://deepgram.com/privacy" target="_blank" rel="noreferrer">deepgram.com/privacy</a></li>
                    <li>Fish Audio: <a href="https://fish.audio/privacy/" target="_blank" rel="noreferrer">fish.audio/privacy</a></li>
                    <li>xAI: <a href="https://x.ai/legal/privacy-policy" target="_blank" rel="noreferrer">x.ai/legal/privacy-policy</a></li>
                    <li>Perplexity: <a href="https://www.perplexity.ai/hub/legal/privacy-policy" target="_blank" rel="noreferrer">perplexity.ai/hub/legal/privacy-policy</a></li>
                    <li>Brave Search: <a href="https://search.brave.com/help/privacy-policy" target="_blank" rel="noreferrer">search.brave.com/help/privacy-policy</a></li>
                    <li>Tavily: <a href="https://tavily.com/privacy" target="_blank" rel="noreferrer">tavily.com/privacy</a></li>
                    <li>Firecrawl: <a href="https://www.firecrawl.dev/privacy-policy" target="_blank" rel="noreferrer">firecrawl.dev/privacy-policy</a></li>
                  </ul>

                  <h2>Use of Information</h2>
                  <p>
                    We use the categories of information we collect for the following business and commercial purposes:
                  </p>
                  <ul>
                    <li><strong>Service Delivery:</strong> we use information to provide and maintain our Services, including to process payments and authenticate your account.</li>
                    <li><strong>Communication:</strong> we use information to communicate with you about Vellum and our Services, including to respond to your questions, inform you of price or Services changes, and send you other transactional or relationship messages.</li>
                    <li><strong>Marketing and Advertising:</strong> we use information to send direct marketing messages (including via email) and target advertisements to you on third-party platforms and websites as described in the &quot;Targeted Advertising and Analytics&quot; section below. You can opt out of direct marketing messages we send by clicking &quot;unsubscribe&quot; or by reaching out via the &quot;Contact Us&quot; section below.</li>
                    <li><strong>Research and Development:</strong> we use information to monitor and analyze Website trends, usage, and activities, improve our Website and Services, develop new products and services, and generate de-identified or aggregated data.</li>
                    <li><strong>Protection and Compliance:</strong> we use information to detect, investigate, and help prevent security incidents and other malicious, deceptive, fraudulent, or illegal activity, help protect the rights and property of Vellum and others, and comply with our legal and financial obligations.</li>
                    <li><strong>Notice/Consent:</strong> we may also use information in other circumstances after giving you notice and/or getting your consent.</li>
                  </ul>

                  <h2>Targeted Advertising and Analytics</h2>
                  <p>
                    We engage others to provide analytics services, serve advertisements, and perform related services across the web and in mobile applications. These entities may use cookies, web beacons, device identifiers, and other technologies to collect information about your use of our Website, including your IP address, web browser and mobile network information, pages viewed, time spent on pages, and links clicked. This information is used to deliver advertising targeted to your interests on other companies&apos; sites or mobile apps and to analyze and track data, determine the popularity of certain content, and better understand your activity. Consistent with user preferences, we also use session replay and product analytics tools to record and analyze how users navigate and interact with our Website so we can diagnose issues and improve usability. The collection of session replay and diagnostic data can be opted in or out of at any time from Settings &gt; Permissions &amp; Privacy.
                  </p>
                  <p>
                    In addition to ad targeting activities that rely on cookies and similar technologies, we work with advertising partners to translate other identifiers, such as your email address, into a unique identifier (called a hashed value) that such partners can then use to show Vellum ads that are more relevant to you across the web and in mobile apps.
                  </p>
                  <p>
                    You can also learn more about interest-based ads, or opt out of having your web browsing information used for behavioral advertising purposes by companies that participate in the Digital Advertising Alliance, by visiting{" "}
                    <a href="http://www.aboutads.info/choices" target="_blank" rel="noreferrer">www.aboutads.info/choices</a>.
                  </p>

                  <h2>Disclosure of Information</h2>
                  <p>
                    We disclose information as follows:
                  </p>
                  <ul>
                    <li><strong>Vendors:</strong> we disclose information to vendors, service providers, contractors and consultants that need this information to provide services to us, such as companies that assist us with web hosting, payment processing, fraud prevention, customer service, data enrichment, analytics, and marketing and advertising.</li>
                    <li><strong>Advertising Partners:</strong> we disclose information to third parties for the purposes described in the Marketing and Advertising subsection above.</li>
                    <li><strong>Professional Advisors:</strong> we disclose information to our lawyers and other professional advisors where necessary to obtain advice or otherwise protect and manage our business interests.</li>
                    <li><strong>Legal Authorities:</strong> we may disclose information to legal authorities and others for the purposes described in the Protection and Compliance subsection above, including if we believe that disclosure is in accordance with, or required by, any applicable law or legal process, including lawful requests by public authorities to meet national security or law enforcement requirements and if we believe that your actions are inconsistent with our user agreements or policies, if we believe that you have violated the law, or if we believe it is necessary to protect the rights, property, and safety of Vellum, our users, the public, or others.</li>
                    <li><strong>Corporate Transactions:</strong> we reserve the right to disclose information in connection with or during negotiations of certain corporate transactions, including the merger, sale of company assets, financing, or acquisition of all or a portion of our business by another company.</li>
                    <li><strong>Affiliates:</strong> we reserve the right to disclose information between and among Vellum and any current or future parents, affiliates, subsidiaries, and other companies under common control and ownership.</li>
                    <li><strong>Consent:</strong> we may disclose information when we have your consent or you direct us to do so.</li>
                  </ul>
                  <p>
                    We also disclose de-identified information that cannot reasonably be used to identify you.
                  </p>

                  <h2>Transfer of Information</h2>
                  <p>
                    Vellum is headquartered in the United States and we have operations and vendors in the United States and other countries. Therefore, we and our vendors may transfer your personal information to, or store or access it in, jurisdictions that may not provide equivalent levels of data protection to your home jurisdiction.
                  </p>

                  <h2>Applicant Information</h2>
                  <p>
                    When you apply for a position with Vellum, we collect the information that you provide in connection with your application. This includes name, contact information, professional credentials and skills, educational and work history, and other information that may be included in a resume or provided during interviews (which may be recorded). This may also include demographic or diversity information that you voluntarily provide. We may also conduct background checks and receive related information.
                  </p>
                  <p>
                    We use applicants&apos; information to facilitate our recruitment activities and process applications, including evaluating candidates and monitoring recruitment and hiring statistics. We use successful candidates&apos; information to administer the employment or independent contractor relationship. We may also use and disclose applicants&apos; information (a) to improve our Website, (b) as otherwise necessary to comply with relevant laws, (c) to respond to subpoenas or warrants served on Vellum, and (d) to protect and defend the rights or property of Vellum or others.
                  </p>

                  <h2>Contact Us</h2>
                  <p>
        If you have any questions about this Privacy Notice, please contact us at{" "}
        <a href="mailto:legal@vellum.ai">legal@vellum.ai</a>.
      </p>
    </DocsContent>
  );
}

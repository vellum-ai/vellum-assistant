"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";

const LINK_ICON = (
  <svg width="100%" height="100%" viewBox="0 0 19 19" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M10.292 3.70833C10.292 3.28776 10.6383 2.91667 11.0837 2.91667H15.042C15.4626 2.91667 15.8337 3.28776 15.8337 3.70833V7.66667C15.8337 8.11198 15.4626 8.45833 15.042 8.45833C14.5967 8.45833 14.2503 8.11198 14.2503 7.66667V5.63802L9.25293 10.6107C8.95605 10.9323 8.43652 10.9323 8.13965 10.6107C7.81803 10.3138 7.81803 9.79427 8.13965 9.4974L13.1123 4.5H11.0837C10.6383 4.5 10.292 4.15365 10.292 3.70833Z" fill="url(#paint0_linear_5046_61039)" />
    <path opacity="0.4" d="M3.16699 5.6875C3.16699 4.59896 4.03288 3.70833 5.14616 3.70833H7.91699C8.33756 3.70833 8.70866 4.07943 8.70866 4.5C8.70866 4.94531 8.33756 5.29167 7.91699 5.29167H5.14616C4.9235 5.29167 4.75033 5.48958 4.75033 5.6875V13.6042C4.75033 13.8268 4.9235 14 5.14616 14H13.0628C13.2607 14 13.4587 13.8268 13.4587 13.6042V10.8333C13.4587 10.4128 13.805 10.0417 14.2503 10.0417C14.6709 10.0417 15.042 10.4128 15.042 10.8333V13.6042C15.042 14.7174 14.1514 15.5833 13.0628 15.5833H5.14616C4.03288 15.5833 3.16699 14.7174 3.16699 13.6042V5.6875Z" fill="url(#paint1_linear_5046_61039)" />
    <defs>
      <linearGradient id="paint0_linear_5046_61039" x1="9.50033" y1="3" x2="9.50033" y2="16" gradientUnits="userSpaceOnUse">
        <stop stopColor="#EBECF8" />
        <stop offset="0.51" stopColor="#D1CBD7" />
        <stop offset="1" stopColor="#C9C4DD" />
      </linearGradient>
      <linearGradient id="paint1_linear_5046_61039" x1="9.50033" y1="3" x2="9.50033" y2="16" gradientUnits="userSpaceOnUse">
        <stop stopColor="#EBECF8" />
        <stop offset="0.51" stopColor="#D1CBD7" />
        <stop offset="1" stopColor="#C9C4DD" />
      </linearGradient>
    </defs>
  </svg>
);

const ARROW_UP_RIGHT = (
  <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentcolor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 7h10v10"></path>
    <path d="M7 17 17 7"></path>
  </svg>
);

interface TemplateIcon {
  src: string;
  srcSet?: string;
}

interface TemplateCardData {
  title: string;
  href: string;
  icons: TemplateIcon[];
}

interface TemplateSection {
  id: string;
  title: string;
  cards: TemplateCardData[];
}

const FEATURED_CARDS: TemplateCardData[] = [
  {
    title: "Review my roadmap based on team capacity",
    href: "/template/roadmap-planner",
    icons: [
      { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg" },
      { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddb22bb9c44f4542f63a5_notion.svg" },
      { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6930f9a3075eb809524f9c15_linear-light-logo.svg" },
    ],
  },
  {
    title: "Detect declining usage trends ahead of renewals",
    href: "/template/account-monitoring-agent",
    icons: [
      {
        src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962b9c9a80a4a0850e29f23_Salesforce.com_logo.svg.png",
        srcSet: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962b9c9a80a4a0850e29f23_Salesforce.com_logo.svg-p-500.png 500w, https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962b9c9a80a4a0850e29f23_Salesforce.com_logo.svg-p-800.png 800w, https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962b9c9a80a4a0850e29f23_Salesforce.com_logo.svg-p-1080.png 1080w, https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962b9c9a80a4a0850e29f23_Salesforce.com_logo.svg.png 1280w",
      },
      { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddc5081ede6a786ba24aa_posthog.svg" },
      { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddb22bb9c44f4542f63a5_notion.svg" },
    ],
  },
  {
    title: "Track team progress without standup meetings",
    href: "/template/cross-team-status-updates",
    icons: [
      { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg" },
      { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddb22bb9c44f4542f63a5_notion.svg" },
      { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6930f9a3075eb809524f9c15_linear-light-logo.svg" },
    ],
  },
  {
    title: "Help me write SEO optimized articles",
    href: "/template/seo-article-generator",
    icons: [
      {
        src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962b2a352120388fb64ec71_google-docs.png",
        srcSet: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962b2a352120388fb64ec71_google-docs-p-500.png 500w, https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962b2a352120388fb64ec71_google-docs-p-800.png 800w, https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962b2a352120388fb64ec71_google-docs-p-1080.png 1080w, https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962b2a352120388fb64ec71_google-docs.png 1481w",
      },
      { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcb05ec3b1d692ef2656_serpapi.svg" },
      { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda9b0f1cabf89a69986c_googlesheets.svg" },
      { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda145995030959e750be_firecrawl.svg" },
    ],
  },
  {
    title: "Flag suspicious Stripe transactions in Slack",
    href: "/template/stripe-transaction-review-agent",
    icons: [
      { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/693111453ed35f6092b082cc_stripelogo.webp" },
      { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg" },
    ],
  },
  {
    title: "Automate KYC checks and send reports to Slack",
    href: "/template/kyc-automation-and-compliance-agent",
    icons: [
      { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg" },
      { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddaaac4f173d49864b86c_hubspot.svg" },
      { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda5a0f617cd26a3287f8_gmail.svg" },
    ],
  },
];

const TEMPLATE_SECTIONS: TemplateSection[] = [
  {
    id: "marketing",
    title: "Marketing and Sales",
    cards: [
      {
        title: "Help me write SEO optimized articles",
        href: "/template/seo-article-generator",
        icons: [
          {
            src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962b2a352120388fb64ec71_google-docs.png",
            srcSet: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962b2a352120388fb64ec71_google-docs-p-500.png 500w, https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962b2a352120388fb64ec71_google-docs-p-800.png 800w, https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962b2a352120388fb64ec71_google-docs-p-1080.png 1080w, https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962b2a352120388fb64ec71_google-docs.png 1481w",
          },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcb05ec3b1d692ef2656_serpapi.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda9b0f1cabf89a69986c_googlesheets.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda145995030959e750be_firecrawl.svg" },
        ],
      },
      {
        title: "Pull call objections and update HubSpot contacts",
        href: "/template/objection-capture-agent-for-sales-calls",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962af1b608741b4a2029557_gong-svg.png" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddaaac4f173d49864b86c_hubspot.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda5a0f617cd26a3287f8_gmail.svg" },
        ],
      },
      {
        title: "Get weekly HubSpot deal health insights",
        href: "/template/active-deal-health-check-agent",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddaaac4f173d49864b86c_hubspot.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda5a0f617cd26a3287f8_gmail.svg" },
        ],
      },
      {
        title: "Review my closed-lost HubSpot deals weekly",
        href: "/template/closed-lost-deal-review-agent",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddb22bb9c44f4542f63a5_notion.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddaaac4f173d49864b86c_hubspot.svg" },
        ],
      },
      {
        title: "Generate long-form articles from any link",
        href: "/template/creative-content-generator-agent",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6931029940c8faf754d6f3bc_globe.png" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddb22bb9c44f4542f63a5_notion.svg" },
        ],
      },
      {
        title: "Convert transcripts into Linkedin posts and articles",
        href: "/template/content-repurposing-agent",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6931029940c8faf754d6f3bc_globe.png" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddb22bb9c44f4542f63a5_notion.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddadc45465f43c2480144_linkedin.svg" },
        ],
      },
      {
        title: "Send me Reddit summaries in Slack",
        href: "/template/reddit-monitoring-agent",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddc93dbc624d7e23db45f_reddit.svg" },
        ],
      },
      {
        title: "Find company intel from the web my sales demo",
        href: "/template/research-agent-for-sales-demos",
        icons: [],
      },
      {
        title: "Find ICP signals in competitor case studies",
        href: "/template/competitor-research-agent",
        icons: [],
      },
      {
        title: "Build a 30-day LinkedIn content plan",
        href: "/template/linkedin-content-planning-ai-agent",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddb22bb9c44f4542f63a5_notion.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddadc45465f43c2480144_linkedin.svg" },
        ],
      },
      {
        title: "Generate a synthetic dataset for AI evals",
        href: "/template/synthetic-dataset-generation-workflow",
        icons: [],
      },
      {
        title: "Turn my Linkedin posts into long-form articles",
        href: "/template/generate-article-in-notion",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddb22bb9c44f4542f63a5_notion.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddadc45465f43c2480144_linkedin.svg" },
        ],
      },
    ],
  },
  {
    id: "customer-support",
    title: "Customer Service",
    cards: [
      {
        title: "Monitor renewals in Hubspot and alert me in Slack",
        href: "/template/renewal-tracker-agent",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddaaac4f173d49864b86c_hubspot.svg" },
        ],
      },
      {
        title: "Auto-assign urgent tickets in Linear",
        href: "/template/ticket-escalation-bot",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6930f9a3075eb809524f9c15_linear-light-logo.svg" },
        ],
      },
      {
        title: "Classify requests and escalate in Slack",
        href: "/template/customer-support-agent",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6930f46630f62aed71577199_database.png" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg" },
        ],
      },
      {
        title: "Build context-aware chatbot with internet access",
        href: "/template/q-a-bot-workflow-reranking",
        icons: [],
      },
    ],
  },
  {
    id: "healthcare",
    title: "Healthcare and Insurance",
    cards: [
      {
        title: "Run review when new prior auth packets arrive",
        href: "/template/prior-authorization-review-agent",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/69310942ce61cf5a0628b059_medical.png" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6930f46630f62aed71577199_database.png" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda8b9d9f3b02da02b2c2_googledrive.svg" },
        ],
      },
      {
        title: "Review claims for compliance and errors",
        href: "/template/claims-compliance-review-agent",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6962ae18d496bb0e8642d19b_sharepoint.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/69310942ce61cf5a0628b059_medical.png" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6930f46630f62aed71577199_database.png" },
        ],
      },
      {
        title: "Generate personalized care plans from EHR",
        href: "/template/personalized-care-plan-agent",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/69310942ce61cf5a0628b059_medical.png" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6930f46630f62aed71577199_database.png" },
        ],
      },
      {
        title: "Find relevant clinical trials for my patients",
        href: "/template/clinical-trial-matchmaker",
        icons: [],
      },
      {
        title: "Speed up prior authorizations for claims",
        href: "/template/prior-authorization-navigator",
        icons: [],
      },
      {
        title: "Unify healthcare data sources in a report",
        href: "/template/population-health-insights-reporter",
        icons: [],
      },
      {
        title: "Analyze claims and benchmark pricing",
        href: "/template/ai-agent-for-claims-review-and-error-detection",
        icons: [],
      },
      {
        title: "Assess claims and verify policy details",
        href: "/template/insurance-claims-automation-agent",
        icons: [],
      },
      {
        title: "Generate patient-doctor match rationale",
        href: "/template/personalized-healthcare-description-based-on-patient-doctor-match",
        icons: [],
      },
      {
        title: "Generate a SOAP note from a medical transcript",
        href: "/template/soap-note-generation",
        icons: [],
      },
      {
        title: "Summarize my PDFs into digestible summaries",
        href: "/template/pdf-document-summarization",
        icons: [],
      },
    ],
  },
  {
    id: "retail",
    title: "Retail, ecommerce and supply chain",
    cards: [
      {
        title: "Support my customers on autopilot",
        href: "/template/e-commerce-shopping-agent",
        icons: [],
      },
      {
        title: "Help me set a competitive pricing strategy",
        href: "/template/retail-pricing-optimizer-agent",
        icons: [],
      },
      {
        title: "Assess my suppliers and recommend actions",
        href: "/template/risk-assessment-agent-for-supply-chain-operations",
        icons: [],
      },
    ],
  },
  {
    id: "financial-services",
    title: "Financial services",
    cards: [
      {
        title: "Flag suspicious Stripe transactions in Slack",
        href: "/template/stripe-transaction-review-agent",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/693111453ed35f6092b082cc_stripelogo.webp" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg" },
        ],
      },
      {
        title: "Automate KYC checks and send reports to Slack",
        href: "/template/kyc-automation-and-compliance-agent",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddaaac4f173d49864b86c_hubspot.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda5a0f617cd26a3287f8_gmail.svg" },
        ],
      },
      {
        title: "Summarize my clients\u2019 portfolios weekly",
        href: "/template/client-portfolio-review-agent",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6930f46630f62aed71577199_database.png" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda5a0f617cd26a3287f8_gmail.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/69310434626042e1e29cace6_Gamma_Symbol_Sky.svg" },
        ],
      },
      {
        title: "Extract and review SEC 10-Ks documents",
        href: "/template/financial-statement-review-workflow-h5rpt",
        icons: [],
      },
    ],
  },
  {
    id: "legal-tech",
    title: "Legal tech",
    cards: [
      {
        title: "Review my contracts and generate risk summaries",
        href: "/template/contract-review-agent",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6930f46630f62aed71577199_database.png" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda9b0f1cabf89a69986c_googlesheets.svg" },
        ],
      },
      {
        title: "Highlight NDA deviations and send alert to Slack",
        href: "/template/nda-deviation-review-agent",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda8b9d9f3b02da02b2c2_googledrive.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda5a0f617cd26a3287f8_gmail.svg" },
        ],
      },
      {
        title: "Review DPAs or privacy policies for compliance",
        href: "/template/compliance-review-agent",
        icons: [
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/6930f46630f62aed71577199_database.png" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691ddcce8a7d7ecad79b0a9c_slack.svg" },
          { src: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/691dda5a0f617cd26a3287f8_gmail.svg" },
        ],
      },
      {
        title: "Generate research memos from legal docs",
        href: "/template/legal-document-processing-agent",
        icons: [],
      },
      {
        title: "Assess contracts and risk and generate a report",
        href: "/template/legal-contract-review-ai-agent",
        icons: [],
      },
      {
        title: "Chat with my legal documents",
        href: "/template/legal-rag-chatbot",
        icons: [],
      },
      {
        title: "Generate a legal research memo",
        href: "/template/ai-legal-research-agent",
        icons: [],
      },
      {
        title: "Extract data from PDF into a CSV file",
        href: "/template/extract-data-from-pdf-to-csv",
        icons: [],
      },
    ],
  },
];

const FILTER_TAGS = [
  "Healthcare",
  "Finance",
  "EdTech",
  "Legal",
  "Retail",
  "Customer support",
  "Marketing",
];

function TemplateCardComponent({ card }: { card: TemplateCardData }) {
  const cardContent = (
    <div className="template_card v2">
      <div className="template_item-wrap">
        <div className="template-tab_content-wrap">
          <div className="tem_header">{card.title}</div>
        </div>
        <div style={{ opacity: 0 }} className="icon_link w-embed">
          {LINK_ICON}
        </div>
      </div>
      <div className="template-card_integrations-wrapper">
        <div className="divider is-templates-card"></div>
        {card.icons.length > 0 && (
          <div>
            <div className="template-integration_list">
              {card.icons.map((icon) => (
                <div key={icon.src} className="template-integration_item w-dyn-item">
                  <Image
                    src={icon.src}
                    loading="lazy"
                    alt=""
                    className="template-integration_icon"
                    width={0}
                    height={0}
                    unoptimized
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  if (card.href) {
    return (
      <div className="template_collection-item w-dyn-item">
        <Link href={card.href} className="template-card_link w-inline-block"></Link>
        {cardContent}
        <div style={{ color: "rgb(113,113,122)", backgroundColor: "rgba(255,255,255,0)" }} className="dot_circ">
          <div className="icon_circ w-embed">{ARROW_UP_RIGHT}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="template_collection-item w-dyn-item">
      {cardContent}
    </div>
  );
}

function FeaturedSection() {
  return (
    <div className="templ_featured">
      <h2 className="heading-2 mobile-center light-mode small">Featured use-cases</h2>
      <div className="templates_content-wrap">
        <div className="template_collection w-dyn-list">
          <div role="list" className="template_collection-list w-dyn-items">
            {FEATURED_CARDS.map((card) => (
              <TemplateCardComponent key={card.title} card={card} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function CategorySection({ section }: { section: TemplateSection }) {
  return (
    <div id={section.id} className="template_sub-wrap">
      <h2 className="heading-2 mobile-center light-mode small">{section.title}</h2>
      <div className="templates_content-wrap">
        <div className="template_collection w-dyn-list">
          <div role="list" className="template_collection-list w-dyn-items">
            {section.cards.map((card) => (
              <TemplateCardComponent key={card.title} card={card} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function UseCasesContent() {
  const [searchQuery, setSearchQuery] = useState("");

  const filterCards = (cards: TemplateCardData[]) => {
    if (!searchQuery) {
      return cards;
    }
    const query = searchQuery.toLowerCase();
    return cards.filter((card) => card.title.toLowerCase().includes(query));
  };

  const filteredSections = TEMPLATE_SECTIONS.map((section) => ({
    ...section,
    cards: filterCards(section.cards),
  })).filter((section) => section.cards.length > 0);

  const filteredFeatured = filterCards(FEATURED_CARDS);

  return (
    <main className="main-wrapper">
      <section className="section_home">
        <div className="padding-global home">
          <div className="container-new">
            <div className="padding-section-medium padding-bottom-0 no-padding-top">
              <div className="home-hero-main template tem">
                <div className="template_header">
                  <div className="z-index-2 max-width-large">
                    <div className="margin-bottom margin-xxsmall">
                      <h1 className="heading-1 text-color-white dark text-align-center">
                        Start with prompts
                      </h1>
                    </div>
                    <div className="text-wrap-balance">
                      <div className="max-width-large align-center">
                        <div className="text-size-regular small-mobile text-align-center">
                          From agents, to RAG workflows that integrate with your favorite tools, to datapipelines that power your most important AI features, you can build it all with Vellum.
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="blub-wrapper-alt">
                  <div className="blub left-align"></div>
                </div>
                <div className="search_temp-wrapper">
                  <div className="temp_form-block w-form">
                    <form
                      className="temp_form"
                      onSubmit={(e) => e.preventDefault()}
                    >
                      <div className="search_wrap">
                        <input
                          className="temp-input w-input"
                          maxLength={256}
                          placeholder="Search template"
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                        />
                        <div className="search_btn-wrap">
                          <button type="submit" className="btn btn_primary search w-button">
                            Search
                          </button>
                        </div>
                      </div>
                    </form>
                  </div>
                </div>
                <div className="search_tem-wrap">
                  <div className="w-dyn-list">
                    <div role="list" className="template_tags-wrapper w-dyn-items">
                      {FILTER_TAGS.map((tag) => (
                        <div key={tag} role="listitem" className="indus-item w-dyn-item">
                          <div className="fill_tag">
                            <button
                              className="check-link_text template_text-tag"
                              onClick={() => setSearchQuery(tag)}
                            >
                              {tag}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                {filteredFeatured.length > 0 && !searchQuery && <FeaturedSection />}
              </div>
            </div>
          </div>
        </div>
      </section>
      <section id="templates" className="section_providers-templates">
        <div className="padding-global new">
          <div className="container-new">
            <div className="content-main bg_none">
              <div className="padding-section-small top-0">
                <div className="template_main-wrap new">
                  <div>
                    <div className="template_main-blcok-wrap">
                      {filteredSections.map((section) => (
                        <CategorySection key={section.id} section={section} />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

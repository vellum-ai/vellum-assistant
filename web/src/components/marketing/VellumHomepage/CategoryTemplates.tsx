"use client";

import { useState } from "react";
import Image from "next/image";

interface Template {
  title: string;
  slug: string;
  shortDescription: string;
  heroIntroParagraph: string;
  industry: string;
  integrations: string[];
}

interface CategoryTemplatesProps {
  templatesByCategory: Record<string, Template[]>;
}

// Integration icons mapping
const INTEGRATION_ICONS: Record<string, string> = {
  "Notion": "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66eb8b62e7f42a3c4b90a3f0_notion-icon.svg",
  "Slack": "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66eb8b62b2ff83b6b4a5d8d4_slack-icon.svg",
  "Salesforce": "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66eb8b62d3a5e58f2e68c1c0_salesforce-icon.svg",
  "HubSpot": "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66eb8b621fd8b0d6e8c2d8e8_hubspot-icon.svg",
  "PostHog": "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/67b1c9e5d6f8a5e7d8c9a1b2_posthog-icon.svg",
  "Google Sheets": "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66eb8b6250d8e6c4b8a7d9f5_sheets-icon.svg",
  "Gmail": "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66eb8b62c3a5e58f2e68c1c1_gmail-icon.svg",
  "Linear": "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/67b1c9e5d6f8a5e7d8c9a1b3_linear-icon.svg",
  "Jira": "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/67b1c9e5d6f8a5e7d8c9a1b4_jira-icon.svg",
  "Airtable": "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66eb8b62b2ff83b6b4a5d8d5_airtable-icon.svg",
};

// Default icon for integrations without specific icons
const DEFAULT_ICON = "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66eb8b62e7f42a3c4b90a3f1_default-integration.svg";

const CATEGORIES = ['Product', 'Sales', 'Marketing', 'Finance', 'Customer support'];

function TemplateCard({ template }: { template: Template }) {
  // Get first 3 integrations
  const displayIntegrations = template.integrations.slice(0, 3);

  return (
    <div 
      style={{
        backgroundColor: "#1a1a1a",
        borderRadius: "12px",
        padding: "1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        border: "1px solid #262626",
        minHeight: "140px",
      }}
    >
      <p style={{ 
        color: "#ffffff", 
        fontSize: "0.9375rem", 
        fontWeight: "500",
        lineHeight: "1.4",
        margin: 0,
        flex: 1,
      }}>
        {template.heroIntroParagraph || template.shortDescription}
      </p>
      
      <div style={{ display: "flex", gap: "0.5rem" }}>
        {displayIntegrations.map((integration, idx) => {
          const iconUrl = INTEGRATION_ICONS[integration.trim()] || DEFAULT_ICON;
          return (
            <div
              key={idx}
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "8px",
                backgroundColor: "#262626",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "6px",
              }}
            >
              <Image
                src={iconUrl}
                alt={integration}
                width={24}
                height={24}
                unoptimized
                style={{ objectFit: "contain" }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CategoryTemplates({ templatesByCategory }: CategoryTemplatesProps) {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const templates = selectedCategory ? templatesByCategory[selectedCategory] || [] : [];

  return (
    <div>
      {/* Category Tabs */}
      <div className="form_filter alt hide-mobile w-form">
        <div className="prompt_box-tags-wrapper hide-mobile alt">
          <div className="collection_hero w-dyn-list">
            <div role="list" className="template_tags-wrapper w-dyn-items" style={{ display: "flex", gap: "0.25rem" }}>
              {CATEGORIES.map(category => {
                const isActive = selectedCategory === category;
                return (
                  <div key={category} role="listitem" className="item_radio inter w-dyn-item">
                    <button
                      type="button"
                      onClick={() => setSelectedCategory(isActive ? null : category)}
                      className="template_text-tag"
                      style={{
                        background: isActive ? "rgba(255, 255, 255, 0.1)" : "transparent",
                        border: "none",
                        borderRadius: "6px",
                        padding: "0.5rem 0.875rem",
                        cursor: "pointer",
                        color: isActive ? "#ffffff" : "#94969c",
                        fontSize: "0.875rem",
                        fontWeight: isActive ? "600" : "500",
                        transition: "all 0.15s ease",
                      }}
                    >
                      {category}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Template Cards - shown when category is selected */}
      {selectedCategory && templates.length > 0 && (
        <div 
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "1rem",
            marginTop: "1rem",
            padding: "0 1rem",
          }}
        >
          {templates.map((template, idx) => (
            <TemplateCard key={template.slug || idx} template={template} />
          ))}
        </div>
      )}

      {/* Empty state if category selected but no templates */}
      {selectedCategory && templates.length === 0 && (
        <div 
          style={{
            marginTop: "1rem",
            padding: "2rem",
            textAlign: "center",
            color: "#71717a",
          }}
        >
          No templates available for this category yet.
        </div>
      )}
    </div>
  );
}

import fs from 'fs';
import path from 'path';

export interface Template {
  title: string;
  slug: string;
  shortDescription: string;
  heroIntroParagraph: string;
  prompt: string;
  industry: string;
  integrations: string[];
  date: string;
  featured?: boolean;
}

const TEMPLATE_CONTENT_DIR = path.join(process.cwd(), '..', 'sanity-content', 'template');

// Simple YAML frontmatter parser
function parseFrontmatter(content: string): { data: Record<string, unknown>; content: string } {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
  const match = content.match(frontmatterRegex);
  
  if (!match) {
    return { data: {}, content };
  }
  
  const frontmatter = match[1];
  const body = content.slice(match[0].length).trim();
  const data: Record<string, unknown> = {};
  
  const lines = frontmatter.split('\n');
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    
    const key = line.slice(0, colonIndex).trim();
    let value: unknown = line.slice(colonIndex + 1).trim();
    
    // Remove quotes
    if (typeof value === 'string' && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    
    // Parse arrays
    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    }
    
    // Parse booleans
    if (value === 'true') value = true;
    if (value === 'false') value = false;
    
    data[key] = value;
  }
  
  return { data, content: body };
}

export function getAllTemplates(): Template[] {
  try {
    const files = fs.readdirSync(TEMPLATE_CONTENT_DIR);
    
    const templates = files
      .filter(file => file.endsWith('.md'))
      .map(file => {
        const filePath = path.join(TEMPLATE_CONTENT_DIR, file);
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const { data } = parseFrontmatter(fileContent);
        
        return {
          title: (data.title as string) || '',
          slug: (data.slug as string) || file.replace('.md', ''),
          shortDescription: (data.shortDescription as string) || '',
          heroIntroParagraph: (data.heroIntroParagraph as string) || '',
          prompt: (data.prompt as string) || '',
          industry: (data.industry as string) || '',
          integrations: (data.integrations as string[]) || [],
          date: (data.date as string) || '',
          featured: (data.featured as boolean) || false,
        } as Template;
      })
      .filter(template => template.title && template.industry)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    
    return templates;
  } catch (error) {
    console.error('Error reading template content:', error);
    return [];
  }
}

export function getTemplatesByCategory(category: string, limit: number = 3): Template[] {
  const allTemplates = getAllTemplates();
  const filtered = allTemplates.filter(t => t.industry === category);
  return filtered.slice(0, limit);
}

export function getTemplateCategories(): string[] {
  return ['Product', 'Sales', 'Marketing', 'Finance', 'Customer support'];
}

// Get templates for all categories, 3 each
export function getTemplatesForHomepage(): Record<string, Template[]> {
  const categories = getTemplateCategories();
  const result: Record<string, Template[]> = {};
  
  for (const category of categories) {
    result[category] = getTemplatesByCategory(category, 3);
  }
  
  return result;
}

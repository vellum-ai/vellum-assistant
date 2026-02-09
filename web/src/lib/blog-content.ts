import fs from 'fs';
import path from 'path';

export interface BlogPost {
  title: string;
  slug: string;
  href: string;
  excerpt: string;
  category: string;
  publishedAt: string;
  readTime: string;
  featuredImage: string;
  authors: string[];
  isFeatured?: boolean;
}

const BLOG_CONTENT_DIR = path.join(process.cwd(), '..', 'sanity-content', 'blog');

// Simple YAML frontmatter parser (no external dependency needed)
function parseFrontmatter(content: string): { data: Record<string, unknown>; content: string } {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
  const match = content.match(frontmatterRegex);
  
  if (!match) {
    return { data: {}, content };
  }
  
  const frontmatter = match[1];
  const body = content.slice(match[0].length).trim();
  const data: Record<string, unknown> = {};
  
  // Parse YAML key-value pairs
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

export function getAllBlogPosts(): BlogPost[] {
  try {
    const files = fs.readdirSync(BLOG_CONTENT_DIR);
    
    const posts = files
      .filter(file => file.endsWith('.md'))
      .map(file => {
        const filePath = path.join(BLOG_CONTENT_DIR, file);
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const { data } = parseFrontmatter(fileContent);
        
        return {
          title: (data.title as string) || '',
          slug: (data.slug as string) || file.replace('.md', ''),
          href: `/blog/${(data.slug as string) || file.replace('.md', '')}`,
          excerpt: (data.excerpt as string) || (data.metaDescription as string) || '',
          category: (data.category as string) || 'Uncategorized',
          publishedAt: (data.publishedAt as string) || '',
          readTime: (data.readTime as string) || '5 min',
          featuredImage: (data.featuredImage as string) || 'https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68f62df5488ea1fb9508c764_Vellum%20Standard%20Blog%20Cover%20Small.png',
          authors: (data.authors as string[]) || [],
          isFeatured: (data.isFeatured as boolean) || false,
        } as BlogPost;
      })
      .filter(post => post.title && post.publishedAt)
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    
    return posts;
  } catch (error) {
    console.error('Error reading blog content:', error);
    return [];
  }
}

export function getFeaturedBlogPosts(limit: number = 6): BlogPost[] {
  const allPosts = getAllBlogPosts();
  // Prioritize featured posts, then sort by date
  const featured = allPosts.filter(p => p.isFeatured);
  const nonFeatured = allPosts.filter(p => !p.isFeatured);
  return [...featured, ...nonFeatured].slice(0, limit);
}

export function getBlogPostBySlug(slug: string): (BlogPost & { content: string }) | null {
  try {
    const filePath = path.join(BLOG_CONTENT_DIR, `${slug}.md`);
    
    if (!fs.existsSync(filePath)) {
      return null;
    }
    
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const { data, content } = parseFrontmatter(fileContent);
    
    return {
      title: (data.title as string) || '',
      slug: (data.slug as string) || slug,
      href: `/blog/${slug}`,
      excerpt: (data.excerpt as string) || (data.metaDescription as string) || '',
      category: (data.category as string) || 'Uncategorized',
      publishedAt: (data.publishedAt as string) || '',
      readTime: (data.readTime as string) || '5 min',
      featuredImage: (data.featuredImage as string) || 'https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68f62df5488ea1fb9508c764_Vellum%20Standard%20Blog%20Cover%20Small.png',
      authors: (data.authors as string[]) || [],
      isFeatured: (data.isFeatured as boolean) || false,
      content,
    };
  } catch (error) {
    console.error('Error reading blog post:', error);
    return null;
  }
}

export function getAllBlogSlugs(): string[] {
  try {
    const files = fs.readdirSync(BLOG_CONTENT_DIR);
    return files
      .filter(file => file.endsWith('.md'))
      .map(file => file.replace('.md', ''));
  } catch {
    return [];
  }
}

export function formatDate(dateString: string): string {
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return dateString;
  }
}

export function getAllCategories(): string[] {
  const posts = getAllBlogPosts();
  const categories = new Set(posts.map(p => p.category));
  return Array.from(categories).sort();
}

export function getBlogPostsByCategory(category: string): BlogPost[] {
  const posts = getAllBlogPosts();
  if (category === 'All' || !category) {
    return posts;
  }
  return posts.filter(p => p.category === category);
}

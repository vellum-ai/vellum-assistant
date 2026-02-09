import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

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

export function getAllBlogPosts(): BlogPost[] {
  try {
    const files = fs.readdirSync(BLOG_CONTENT_DIR);
    
    const posts = files
      .filter(file => file.endsWith('.md'))
      .map(file => {
        const filePath = path.join(BLOG_CONTENT_DIR, file);
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const { data } = matter(fileContent);
        
        return {
          title: data.title || '',
          slug: data.slug || file.replace('.md', ''),
          href: `/blog/${data.slug || file.replace('.md', '')}`,
          excerpt: data.excerpt || data.metaDescription || '',
          category: data.category || 'Uncategorized',
          publishedAt: data.publishedAt || '',
          readTime: data.readTime || '5 min',
          featuredImage: data.featuredImage || 'https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68f62df5488ea1fb9508c764_Vellum%20Standard%20Blog%20Cover%20Small.png',
          authors: data.authors || [],
          isFeatured: data.isFeatured || false,
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

export function formatDate(dateString: string): string {
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch (_) {
    return dateString;
  }
}

export interface DocsSearchChunk {
  id: string;
  route: string;
  url: string;
  pageTitle: string;
  breadcrumb: string;
  heading: string;
  headingLevel: 1 | 2 | 3;
  sectionId: string | null;
  body: string;
  keywords: string[];
}

export interface DocsSearchIndexFile {
  version: number;
  generatedAt: string;
  chunks: DocsSearchChunk[];
}

export interface DocsSearchResult {
  id: string;
  url: string;
  route: string;
  pageTitle: string;
  heading: string;
  sectionId: string | null;
  snippet: string;
  score: number;
}

export interface DocsSearchResponse {
  query: string;
  tookMs: number;
  results: DocsSearchResult[];
}

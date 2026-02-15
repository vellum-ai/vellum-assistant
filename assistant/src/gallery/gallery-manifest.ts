export interface GalleryManifest {
  version: number;
  updatedAt: string;
  categories: GalleryCategory[];
  apps: GalleryApp[];
}

export interface GalleryCategory {
  id: string;       // e.g. "productivity", "health", "fun"
  name: string;     // Display name
  icon: string;     // Emoji
}

export interface GalleryApp {
  id: string;              // Unique identifier
  name: string;
  description: string;
  icon: string;            // Emoji
  category: string;        // Category ID
  version: string;         // e.g. "1.0.0"
  featured?: boolean;
  schemaJson: string;      // JSON schema for app records
  htmlDefinition: string;  // Complete HTML app
}

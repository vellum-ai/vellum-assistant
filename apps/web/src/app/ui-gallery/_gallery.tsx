// TODO: port from platform
import type { ComponentType, ReactNode } from "react";

export interface GalleryExampleEntry {
  name?: string;
  title?: string;
  description?: string;
  Component?: ComponentType;
  render?: () => ReactNode;
}

export interface GalleryEntry {
  name: string;
  category?: string;
  description?: string;
  examples?: GalleryExampleEntry[];
  render?: () => ReactNode;
}
export function Gallery(_props: { entries?: GalleryEntry[] }) { return null; }

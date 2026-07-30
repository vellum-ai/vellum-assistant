import { ReleasesContent } from "@/app/docs/_components/releases-content";
import { createMetadata } from "@/lib/metadata";
import { fetchReleases } from "@/lib/releases-server";

export const dynamic = "force-dynamic";

export const metadata = createMetadata({
  title: "Releases - Vellum Docs",
  description:
    "Vellum release notes, versioning, update channels, and how to stay up to date with the latest features and fixes.",
  path: "/docs/releases",
});

export default async function ReleasesPage() {
  const releases = await fetchReleases();
  return <ReleasesContent releases={releases} />;
}

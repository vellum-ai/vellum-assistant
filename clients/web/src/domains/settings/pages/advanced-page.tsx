import { ArchiveSections } from "@/domains/settings/pages/archive-sections";
import { Tabs } from "@vellumai/design-library/components/tabs";

export function AdvancedPage() {
  // Archive is the only Advanced section for now. The tab shell exists so
  // future sections can slot in as sibling tabs (adding ?tab= URL sync at
  // that point) without another layout change.
  return (
    <div className="space-y-6">
      <Tabs.Root defaultValue="archive">
        <Tabs.List>
          <Tabs.Trigger value="archive">Archive</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Panel value="archive" className="pt-4">
          <ArchiveSections />
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}

import { ArchiveSections } from "@/domains/settings/pages/archive-sections";
import { Tabs } from "@vellumai/design-library/components/tabs";

export function AdvancedPage() {
  // Archive is the sole Advanced section, so the tab shell omits ?tab=
  // URL sync; a controlled value with one option is dead code.
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

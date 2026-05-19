
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Card } from "@vellum/design-library/components/card";
import { assistantsListOptions } from "@/generated/api/@tanstack/react-query.gen.js";

import { TrustRulesModal } from "@/components/app/settings/TrustRules/trust-rules-modal.js";

export function TrustRules() {
  const [open, setOpen] = useState(false);
  const { data: assistantList } = useQuery(assistantsListOptions());
  const assistantId = assistantList?.results?.[0]?.id;

  return (
    <Card>
      <h2 className="text-title-medium text-[var(--content-default)]">
        Trust Rules
      </h2>
      <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
        Control which tool actions are automatically allowed or denied.
      </p>
      <div className="mt-3">
        <Button
          variant="outlined"
          onClick={() => setOpen(true)}
          disabled={!assistantId}
        >
          Manage
        </Button>
      </div>
      {assistantId && open && (
        <TrustRulesModal
          assistantId={assistantId}
          onClose={() => setOpen(false)}
        />
      )}
    </Card>
  );
}

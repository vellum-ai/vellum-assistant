import { Link2 } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";

interface ShareConnectionLinkButtonProps {
  onClick: () => void;
}

export function ShareConnectionLinkButton({
  onClick,
}: ShareConnectionLinkButtonProps) {
  return (
    <Button
      variant="outlined"
      size="compact"
      leftIcon={<Link2 className="h-3.5 w-3.5" />}
      onClick={onClick}
    >
      Share Connection Link
    </Button>
  );
}

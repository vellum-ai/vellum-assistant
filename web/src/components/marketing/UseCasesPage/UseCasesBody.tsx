"use client";

import { UseCasesContent } from "./UseCasesContent";
import { UseCasesHeader } from "./UseCasesHeader";
import { UseCasesStyles } from "./UseCasesStyles";

export function UseCasesBody() {
  return (
    <>
      <UseCasesStyles />
      <UseCasesHeader />
      <UseCasesContent />
    </>
  );
}

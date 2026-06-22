import { useQuery } from "@tanstack/react-query";

import { skillsCategoriesGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

export interface CategoryInfo {
  slug: string;
  label: string;
  description: string;
  icon: string;
}

export function useSkillCategories(assistantId: string) {
  return useQuery({
    ...skillsCategoriesGetOptions({
      path: { assistant_id: assistantId },
    }),
    select: (data): CategoryInfo[] => data.categories,
    staleTime: 5 * 60 * 1000,
  });
}

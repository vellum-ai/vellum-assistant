import type {
  AppsByIdOpenPostResponse,
  AppsGetResponse,
} from "@/generated/daemon/types.gen";

export type AppSummary = AppsGetResponse["apps"][number];

export type AppOpenResponse = AppsByIdOpenPostResponse;

import type {
  AppsByIdOpenPostResponse,
  AppsGetResponse,
  AppsImportbundlePostResponse,
} from "@/generated/daemon/types.gen";

export type AppSummary = AppsGetResponse["apps"][number];

export type AppOpenResponse = AppsByIdOpenPostResponse;

export type ImportBundleResponse = AppsImportbundlePostResponse;

import { client } from "@/generated/api/client.gen.js";

client.setConfig({
  baseUrl: import.meta.env.VITE_API_BASE_URL || "/api",
});

export { client };

import type { EnvironmentApi } from "@t3tools/contracts";
import { createEnvironmentApi } from "./environmentApi";
import { getPrimaryEnvironmentConnection } from "./environments/runtime";

let cachedNativeApi: EnvironmentApi | undefined;

export function readNativeApi(): EnvironmentApi | undefined {
  if (cachedNativeApi) return cachedNativeApi;
  const connection = getPrimaryEnvironmentConnection();
  cachedNativeApi = createEnvironmentApi(connection.client);
  return cachedNativeApi;
}

export function ensureNativeApi(): EnvironmentApi {
  const api = readNativeApi();
  if (!api) throw new Error("Native API not found");
  return api;
}

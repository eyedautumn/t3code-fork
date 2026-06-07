import { useSettings } from "./hooks/useSettings";

export function useAppSettings() {
  return { settings: useSettings() };
}

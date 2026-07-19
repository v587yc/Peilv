import { loadStoredValue, type StorageWriteResult } from "./workstation-storage";

export function loadBrowserPreference<T>(storage: Storage, key: string, fallback: T): T {
  return loadStoredValue(storage, key, fallback);
}

export function saveBrowserPreference<T>(storage: Storage, key: string, value: T): StorageWriteResult {
  try {
    storage.setItem(key, JSON.stringify(value));
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "保存失败" };
  }
}

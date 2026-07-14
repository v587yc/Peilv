export type StorageWriteResult =
  | { success: true }
  | { success: false; error: string };

export function loadStoredValue<T>(
  storage: Storage,
  key: string,
  fallback: T,
): T {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveStoredValue(
  storage: Storage,
  key: string,
  value: unknown,
): boolean {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

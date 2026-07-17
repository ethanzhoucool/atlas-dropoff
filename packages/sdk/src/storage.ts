/**
 * Persistence with graceful degradation.
 *
 * Uses @react-native-async-storage/async-storage when the app has it
 * installed; otherwise falls back to an in-memory map so the SDK keeps
 * working (ids just won't survive an app restart).
 */

export interface AtlasStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function loadAsyncStorage(): AsyncStorageLike | undefined {
  try {
    // A literal module id inside try/catch is Metro's "optional dependency"
    // pattern: the app still bundles when async-storage isn't installed, and
    // the require throws here at runtime instead — which we swallow.
    const mod =
      typeof require === "function"
        ? (require("@react-native-async-storage/async-storage") as any)
        : undefined;
    const storage = (mod?.default ?? mod) as AsyncStorageLike | undefined;
    if (storage && typeof storage.getItem === "function") {
      return storage;
    }
  } catch {
    // Not installed (or native module missing) — fall through to memory.
  }
  return undefined;
}

export function createStorage(): AtlasStorage {
  const asyncStorage = loadAsyncStorage();
  if (asyncStorage) {
    // Thin wrapper rather than returning the module directly: keeps `this`
    // binding safe and the surface limited to what we actually use.
    return {
      getItem: (key) => asyncStorage.getItem(key),
      setItem: (key, value) => asyncStorage.setItem(key, value),
      removeItem: (key) => asyncStorage.removeItem(key),
    };
  }

  const memory = new Map<string, string>();
  return {
    getItem: async (key) => (memory.has(key) ? (memory.get(key) as string) : null),
    setItem: async (key, value) => {
      memory.set(key, value);
    },
    removeItem: async (key) => {
      memory.delete(key);
    },
  };
}

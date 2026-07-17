/**
 * Id generation + install-id persistence.
 */

import type { AtlasStorage } from "./storage";

const INSTALL_ID_KEY = "atlas_analytics.install_id";

/**
 * UUID v4-shaped id. Uses crypto.getRandomValues when the runtime provides it
 * (newer Hermes / polyfilled Expo), otherwise Math.random — plenty for
 * analytics identifiers, and it avoids any crypto polyfill dependency.
 */
export function generateId(): string {
  const bytes = new Uint8Array(16);
  const cryptoObj =
    typeof globalThis !== "undefined" ? (globalThis as any).crypto : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  // RFC 4122 version + variant bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/**
 * Stable per-install id: read it from storage, or mint + persist one.
 * Never throws — a storage failure just yields a fresh (unpersisted) id.
 */
export async function getOrCreateInstallId(storage: AtlasStorage): Promise<string> {
  try {
    const existing = await storage.getItem(INSTALL_ID_KEY);
    if (existing) {
      return existing;
    }
    const id = generateId();
    await storage.setItem(INSTALL_ID_KEY, id);
    return id;
  } catch {
    return generateId();
  }
}

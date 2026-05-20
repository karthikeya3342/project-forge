/** Persistent "always allow" storage for HITL checkpoint types. */

const KEY = 'vantage:always-allow';

export function isAlwaysAllowed(type: string): boolean {
  try {
    const stored = localStorage.getItem(KEY);
    const types: string[] = stored ? JSON.parse(stored) : [];
    return types.includes(type);
  } catch {
    return false;
  }
}

export function addAlwaysAllowed(type: string): void {
  try {
    const stored = localStorage.getItem(KEY);
    const types: string[] = stored ? JSON.parse(stored) : [];
    if (!types.includes(type)) {
      localStorage.setItem(KEY, JSON.stringify([...types, type]));
    }
  } catch {}
}

export function clearAlwaysAllowed(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

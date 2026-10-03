/**
 * Read a `localStorage` value by its current key, falling back to the key it had before the rebrand.
 *
 * Three preferences are stored in the browser — the theme, the sidebar's open state, and the thread
 * the direct Bot chat talks in. All three were written under an `openbot-` prefix by every build
 * before this one, and a rename that read only the new key would discard them on the first load
 * after upgrade: the theme would flip to light on a machine the person had set dark, the sidebar
 * would open shut, and the Bot chat would mint a new thread and answer as if nothing had ever been
 * said. None of those fail loudly. They are a person's own settings, silently reset.
 *
 * The old key is read and then removed, so the value is migrated rather than duplicated: a
 * preference the person has since changed is not pinned to the value they had on the day of the
 * upgrade, and the stale key does not linger to be read by the next rename.
 *
 * Every read is guarded. Storage throws in some privacy modes and can be full, and a preference
 * is not worth taking the app down for — the same reason `index.html` wraps its own read in
 * `try`.
 */
export function readStoredPreference(
  currentKey: string,
  legacyKey: string,
): string | null {
  try {
    const current = window.localStorage.getItem(currentKey);
    if (current !== null) return current;
  } catch {
    return null;
  }
  try {
    const legacy = window.localStorage.getItem(legacyKey);
    if (legacy !== null) {
      // Written back under the new key so the next read is the ordinary path, and the old one is
      // dropped so it cannot be read again.
      try {
        window.localStorage.setItem(currentKey, legacy);
        window.localStorage.removeItem(legacyKey);
      } catch {
        // A full or read-only store keeps the legacy value where it is; it will simply be migrated
        // on a later visit rather than this one.
      }
    }
    return legacy;
  } catch {
    return null;
  }
}

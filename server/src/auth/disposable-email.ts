/**
 * Throwaway / temporary email domains to disallow for user sign-ups and authentication.
 *
 * Prevents users from endlessly registering accounts to farm free credits (50 credits
 * granted at account creation) and avoids high bounce rates.
 */

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamailblock.com",
  "guerrillamail.biz",
  "guerrillamail.de",
  "guerrillamail.net",
  "guerrillamail.org",
  "sharklasers.com",
  "grr.la",
  "pokemail.net",
  "tempmail.com",
  "temp-mail.org",
  "10minutemail.com",
  "10minutemail.net",
  "throwawaymail.com",
  "throwaway.email",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
  "dispostable.com",
  "trashmail.com",
  "trashmail.net",
  "trashmail.org",
  "trashmail.me",
  "maildrop.cc",
  "inboxkitten.com",
  "fakemailgenerator.com",
  "emailondeck.com",
  "burnermail.io",
  "getairmail.com",
  "mohmal.com",
  "crazymailing.com",
  "tempail.com",
  "disposablemail.com",
  "nada.ltd",
  "getnada.com",
  "mytemp.email",
  "tempinbox.com",
]);

/**
 * Check whether an email address uses a known temporary/disposable domain.
 *
 * Matches exact domains and subdomains (e.g. `sub.mailinator.com`).
 */
export function isDisposableEmail(email: string): boolean {
  if (!email || typeof email !== "string") return false;
  const atIndex = email.lastIndexOf("@");
  if (atIndex === -1 || atIndex === email.length - 1) return false;

  const domain = email
    .slice(atIndex + 1)
    .trim()
    .toLowerCase();
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return true;
  }

  // Check subdomains, e.g. "team.mailinator.com" -> checks "mailinator.com"
  const parts = domain.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const parentDomain = parts.slice(i).join(".");
    if (DISPOSABLE_DOMAINS.has(parentDomain)) {
      return true;
    }
  }

  return false;
}

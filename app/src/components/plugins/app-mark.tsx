import {
  IconBrandAirtable,
  IconBrandAsana,
  IconBrandDiscord,
  IconBrandGithub,
  IconBrandGitlab,
  IconBrandGmail,
  IconBrandGoogle,
  IconBrandGoogleDrive,
  IconBrandIntercom,
  IconBrandJira,
  IconBrandNotion,
  IconBrandSlack,
  IconBrandSpotify,
  IconBrandStripe,
  IconBrandSupabase,
  IconBrandTelegram,
  IconBrandTrello,
  IconBrandTwitter,
  IconBrandX,
  IconBrandZoom,
  IconPlug,
} from "@tabler/icons-react";
import type * as React from "react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Composio's own mark, from the same CDN that serves every other toolkit's.
 *
 * Used by the sandbox & workbench row, which names Composio itself rather than an app reached
 * through it. Served by the vendor rather than checked in as a file so it cannot go stale, and it
 * goes through `AppMark` — which falls back to the glyph mark on a failed load — so a CDN that is
 * unreachable costs a glyph and not the row.
 */
export const COMPOSIO_LOGO = "https://logos.composio.dev/api/composio";

/**
 * Built-in brand icon mappings for common integrations and third-party apps.
 */
export const MARKS: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  gmail: IconBrandGmail,
  "google-mail": IconBrandGmail,
  google_mail: IconBrandGmail,
  "google-drive": IconBrandGoogleDrive,
  googledrive: IconBrandGoogleDrive,
  google_drive: IconBrandGoogleDrive,
  "google-calendar": IconBrandGoogle,
  google_calendar: IconBrandGoogle,
  "google-docs": IconBrandGoogle,
  "google-sheets": IconBrandGoogle,
  google: IconBrandGoogle,
  notion: IconBrandNotion,
  slack: IconBrandSlack,
  github: IconBrandGithub,
  gitlab: IconBrandGitlab,
  jira: IconBrandJira,
  trello: IconBrandTrello,
  discord: IconBrandDiscord,
  twitter: IconBrandTwitter,
  x: IconBrandX,
  telegram: IconBrandTelegram,
  spotify: IconBrandSpotify,
  zoom: IconBrandZoom,
  airtable: IconBrandAirtable,
  asana: IconBrandAsana,
  intercom: IconBrandIntercom,
  stripe: IconBrandStripe,
  supabase: IconBrandSupabase,
  composio: IconPlug,
  workbench: IconPlug,
  sandbox: IconPlug,
};

/**
 * Normalizes an app key or connector identifier to resolve its brand mark icon.
 */
export function markFor(
  key?: string | null,
): React.ComponentType<{ className?: string }> {
  if (!key) return IconPlug;
  const normalized = key.replace(/^composio-/, "").toLowerCase();
  const slug = normalized.replace(/_/g, "-");

  if (MARKS[slug]) return MARKS[slug];
  if (MARKS[normalized]) return MARKS[normalized];
  if (slug.startsWith("google-") || slug.startsWith("google_")) {
    return IconBrandGoogle;
  }
  return IconPlug;
}

export interface AppMarkProps {
  serverId?: string | null;
  logo?: string | null;
  className?: string;
  alt?: string;
}

/**
 * Renders the app logo image (if available from broker metadata) or falls back
 * to the corresponding brand icon / plug mark.
 */
export function AppMark({ serverId, logo, className, alt = "" }: AppMarkProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const FallbackMark = markFor(serverId);

  if (logo && !imageFailed) {
    return (
      <img
        alt={alt}
        className={cn("rounded-xs object-contain", className ?? "size-4")}
        loading="lazy"
        referrerPolicy="no-referrer"
        src={logo}
        onError={() => setImageFailed(true)}
      />
    );
  }

  return <FallbackMark className={className ?? "size-4"} />;
}

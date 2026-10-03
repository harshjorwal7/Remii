import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import QRCode from "react-qr-code";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  telegramLinkMutationOptions,
  telegramStatusQueryOptions,
  telegramUnlinkMutationOptions,
} from "@/lib/telegram";

export const Route = createFileRoute("/_authed/settings/telegram")({
  component: RouteComponent,
});

/**
 * Chat with the Bot from Telegram.
 *
 * Linking binds one Telegram chat to the signed-in person: the page mints a single-use code,
 * the person sends `/start <code>` to the bot, and every later message from that chat runs a
 * turn as them. Unlinking drops it. Without a bot token on the deployment there is no bot to
 * link to, and the page says so rather than drawing a code box that goes nowhere.
 */
function RouteComponent() {
  const queryClient = useQueryClient();
  const status = useQuery(telegramStatusQueryOptions());
  const link = useMutation(telegramLinkMutationOptions(queryClient));
  const unlink = useMutation(telegramUnlinkMutationOptions(queryClient));
  const [code, setCode] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard needs a secure context; the readonly input below stays selectable.
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <PageShell
      description="Chat with your Bot from Telegram. Messages there run as you, in your channel with Remii."
      title="Telegram"
    >
      {status.isPending ? null : status.isError || !status.data?.configured ? (
        <PageSection>
          <PageRows>
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Not configured</ItemTitle>
                <ItemDescription>
                  No Telegram bot is configured on this deployment yet. Set
                  TELEGRAM_BOT_TOKEN (and TELEGRAM_BOT_USERNAME) and restart the
                  server, then come back here.
                </ItemDescription>
              </ItemContent>
            </Item>
          </PageRows>
        </PageSection>
      ) : (
        <PageSection>
          <PageRows>
            <Item size="sm">
              <ItemContent>
                <ItemTitle>
                  {status.data.linked ? "Linked" : "Not linked"}
                </ItemTitle>
                <ItemDescription>
                  {status.data.linked
                    ? "Messages from your linked chat run as you."
                    : "Link a chat to run turns as you from Telegram."}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {status.data.linked ? (
                  <Button
                    disabled={unlink.isPending}
                    onClick={() => unlink.mutate()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {unlink.isPending ? "Unlinking…" : "Unlink"}
                  </Button>
                ) : (
                  <Button
                    disabled={link.isPending}
                    onClick={() =>
                      link.mutate(undefined, {
                        onSuccess: (data) => {
                          setCode(data.code);
                          setLinkUrl(data.link);
                          setCopied(false);
                        },
                      })
                    }
                    size="sm"
                    type="button"
                  >
                    {link.isPending ? "Making code…" : "Link a chat"}
                  </Button>
                )}
              </ItemActions>
            </Item>
            {code && linkUrl ? (
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>Scan or send this to the bot</ItemTitle>
                  <ItemDescription>
                    Point your phone camera at the code, or open the link —
                    either starts a chat with the bot carrying your link code.
                    It expires in 15 minutes.
                  </ItemDescription>
                  <div className="mt-3 flex flex-col items-start gap-3">
                    <div className="rounded-lg border border-border bg-white p-3">
                      <QRCode size={160} value={linkUrl} />
                    </div>
                    <div className="flex w-full flex-col gap-2">
                      <Input readOnly value={`/start ${code}`} />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          onClick={() => void copy(code)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {copied ? "Copied!" : "Copy code"}
                        </Button>
                        <Button
                          render={
                            <a
                              href={linkUrl}
                              rel="noreferrer"
                              target="_blank"
                            />
                          }
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Open Telegram
                        </Button>
                      </div>
                    </div>
                  </div>
                </ItemContent>
              </Item>
            ) : null}
          </PageRows>
        </PageSection>
      )}
    </PageShell>
  );
}

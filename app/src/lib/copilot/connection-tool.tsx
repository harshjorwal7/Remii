import { useRenderTool } from "@copilotkit/react-core/v2";
import {
  IconArrowUpRight,
  IconCheck,
  IconLoader2,
  IconRefresh,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { AppMark } from "@/components/plugins/app-mark";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/client";
import { pluginKeys } from "@/lib/plugins/queries";

const parameters = z.object({
  app: z.string().optional(),
  reason: z.string().optional(),
});

type ToolPayload = {
  ok?: boolean;
  app?: string;
  title?: string;
  /**
   * The app's own mark as Composio publishes it, so the card shows the vendor's
   * logo rather than a generic plug. Null when the app publishes none.
   */
  logo?: string | null;
  serverId?: string;
  connectUrl?: string;
  settingsUrl?: string;
  reason?: string;
  error?: string;
};

/**
 * The tool result off the wire, parsed however many times it was encoded.
 *
 * A server-executed tool answers with a string, and the run event carries `JSON.stringify` of
 * that answer — so the card receives a JSON string of a JSON string. Parsing once leaves a
 * string with no `connectUrl`, and the card renders with no button: the person sees a prompt to
 * connect with nothing to click. Unwrap until the value stops being JSON text.
 */
function decodePayload(result: unknown): ToolPayload {
  let current = result;
  for (let depth = 0; depth < 3 && typeof current === "string"; depth += 1) {
    const trimmed = current.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith('"')) break;
    try {
      current = JSON.parse(current);
    } catch {
      break;
    }
  }
  if (current && typeof current === "object") return current as ToolPayload;
  if (typeof current === "string" && current.length > 0) {
    return { ok: false, error: current };
  }
  return {};
}

function ConnectionCard({
  payload,
  given,
}: {
  payload: ToolPayload;
  given?: { app?: string; reason?: string };
}) {
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [connected, setConnected] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const serverId =
    payload.serverId ?? (payload.app ? `composio-${payload.app}` : null);
  const title = payload.title ?? payload.app ?? given?.app ?? "App";

  const checkConnection = useCallback(async () => {
    if (!serverId) return;
    setChecking(true);
    setCheckError(null);
    try {
      const response = await client(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/connection/confirm`,
        { method: "POST" },
      );
      const data = await response.json();
      if (data.connected) {
        setConnected(true);
        void queryClient.invalidateQueries({
          queryKey: pluginKeys.connections(),
        });
        void queryClient.invalidateQueries({
          queryKey: ["plugins", "servers", serverId, "accounts"],
        });
      }
    } catch (err) {
      setCheckError((err as Error).message || "Could not verify connection.");
    } finally {
      setChecking(false);
    }
  }, [serverId, queryClient]);

  // When window regains focus, auto-check if user just authorized in popup/tab
  useEffect(() => {
    if (connected || !payload.connectUrl) return;
    const handleFocus = () => {
      void checkConnection();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [connected, payload.connectUrl, checkConnection]);

  if (payload.ok === false) {
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
        <p className="font-medium">Could not connect to {title}</p>
        <p className="text-muted-foreground">{payload.error}</p>
      </div>
    );
  }

  return (
    <div className="my-1 flex max-w-md flex-col gap-2.5 rounded-lg border border-border bg-card p-3.5 text-xs shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
            <AppMark
              serverId={serverId ?? given?.app}
              logo={payload.logo}
              className="size-4 text-primary"
            />
          </div>
          <div>
            <p className="font-medium text-foreground">Connect {title}</p>
            <p className="text-[11px] text-muted-foreground">
              {payload.reason ?? given?.reason ?? "Authorization required"}
            </p>
          </div>
        </div>

        {connected ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            <IconCheck className="size-3" />
            Connected
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-2 pt-1">
        {(payload.connectUrl || payload.settingsUrl) && !connected ? (
          <Button
            size="sm"
            className="px-3 text-xs"
            onClick={() => {
              const url = payload.connectUrl ?? payload.settingsUrl;
              if (url) {
                window.open(url, "_blank", "noopener,noreferrer");
              }
            }}
          >
            {payload.settingsUrl && !payload.connectUrl
              ? "Open Connection Settings"
              : "Connect Account"}
            <IconArrowUpRight data-icon="inline-end" />
          </Button>
        ) : null}

        {!connected && payload.connectUrl ? (
          <Button
            size="sm"
            variant="outline"
            className="px-2.5 text-xs text-muted-foreground"
            disabled={checking}
            onClick={() => void checkConnection()}
          >
            {checking ? (
              <IconLoader2 className="animate-spin" data-icon="inline-start" />
            ) : (
              <IconRefresh data-icon="inline-start" />
            )}
            {checking ? "Checking…" : "Check Status"}
          </Button>
        ) : null}

        {connected ? (
          <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
            Account connected! The coworker can now access this app.
          </p>
        ) : null}
      </div>

      {checkError ? (
        <p className="text-[11px] text-destructive">{checkError}</p>
      ) : null}
    </div>
  );
}

export function ConnectionTool() {
  useRenderTool({
    name: "connect_app",
    parameters,
    render: ({ parameters: given, result, status }) => {
      const running = status !== "complete" && result === undefined;

      const payload = decodePayload(result);

      return (
        <ToolLine
          label={payload.title ? `Connect ${payload.title}` : "Connect App"}
          detail={given?.app}
          running={running}
        >
          {running ? (
            <p className="text-xs text-muted-foreground">
              Preparing connection link for {given?.app ?? "app"}…
            </p>
          ) : (
            <ConnectionCard payload={payload} given={given} />
          )}
        </ToolLine>
      );
    },
  });

  return null;
}

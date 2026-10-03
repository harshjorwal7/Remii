import { z } from "zod";
import type { ComposioBroker } from "../plugins/broker";
import { brokerReturnUrl, isFieldScheme } from "../plugins/broker";
import { connectedAccountsUrlFor } from "../plugins/oauth";
import type { PluginStore } from "../plugins/store";
import type { GrantedTool } from "../plugins/tools";
import type { RunAssertion } from "./callback-token";

export const CONNECT_APP_TOOL = "connect_app";

const parameters = z.object({
  app: z
    .string()
    .describe(
      "The name or slug of the app to connect, e.g. 'gmail', 'slack', 'github', 'linear', 'notion'",
    ),
  reason: z
    .string()
    .optional()
    .describe("Why you need the user to connect this app"),
});

export function connectAppTool(options: {
  from: RunAssertion;
  broker?: ComposioBroker;
  pluginStore: PluginStore;
  appUrl?: string;
}): GrantedTool {
  const { from, broker, pluginStore, appUrl } = options;

  return {
    name: CONNECT_APP_TOOL,
    ref: `bot/${CONNECT_APP_TOOL}`,
    description:
      "Provide an interactive connection card in the chat for the user to connect their account for an enabled app " +
      "through Composio. This never enables an app or creates deployment configuration.",
    parameters,
    execute: async (args: unknown) => {
      const parsed = parameters.safeParse(args);
      if (!parsed.success) {
        return JSON.stringify({
          ok: false,
          error: "Please specify the app you want the user to connect.",
        });
      }

      const requested = parsed.data.app
        .toLowerCase()
        .replace(/^composio-/, "")
        .trim();
      if (!requested) {
        return JSON.stringify({
          ok: false,
          error: "App slug cannot be empty.",
        });
      }
      if (!broker) {
        return JSON.stringify({
          ok: false,
          error:
            "Composio integration is not configured on this deployment. Set the Composio API key in the environment.",
        });
      }

      const apps = await broker.listApps();
      const app = apps.find(
        (candidate) =>
          candidate.slug.toLowerCase() === requested ||
          candidate.name.toLowerCase() === requested,
      );
      if (!app || app.connection.kind === "unsupported") {
        return JSON.stringify({
          ok: false,
          error: `${app?.name ?? requested} is not available in the Composio catalogue.`,
        });
      }

      let enabled = await pluginStore.brokeredAppRow(app.slug);
      if (!enabled) {
        /*
         * The person talking to the Bot asked for the app, and an app they
         * can see in the catalogue is an app they may want connected: adding it is
         * the step before connecting, not somebody else's job. This is what the
         * "Add" button on App connections does; doing it here keeps a Bot
         * that has been asked from having to hand the request back to a setting.
         */
        try {
          const server = await pluginStore.addBrokeredApp({
            slug: app.slug,
            title: app.name,
            by: from.actorId,
            connection: app.connection,
          });
          enabled = { id: server.id, authScheme: server.authScheme };
        } catch (error) {
          return JSON.stringify({
            ok: false,
            error: `${app.name} could not be set up: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      if (isFieldScheme(enabled.authScheme)) {
        return JSON.stringify({
          ok: true,
          app: app.slug,
          title: app.name,
          logo: app.logo,
          serverId: enabled.id,
          settingsUrl: connectedAccountsUrlFor(appUrl, {
            serverId: enabled.id,
          }),
          reason: `${app.name} needs account credentials. Open its connection settings to enter them.`,
        });
      }
      if (enabled.authScheme === "NO_AUTH") {
        return JSON.stringify({
          ok: true,
          app: app.slug,
          title: app.name,
          logo: app.logo,
          serverId: enabled.id,
          alreadyAvailable: true,
          reason: `${app.name} does not require an account connection. Its enabled tools can be used directly.`,
        });
      }

      const returnUrl = brokerReturnUrl(
        connectedAccountsUrlFor(appUrl, { serverId: enabled.id }),
      );
      const { redirectUrl } = await broker.authorize({
        userId: from.actorId,
        toolkit: app.slug,
        returnUrl,
        allowMultiple: true,
      });

      return JSON.stringify({
        ok: true,
        app: app.slug,
        title: app.name,
        logo: app.logo,
        serverId: enabled.id,
        connectUrl: redirectUrl,
        reason:
          parsed.data.reason ??
          `Connect your ${app.name} account so I can assist you with your tasks.`,
      });
    },
  };
}

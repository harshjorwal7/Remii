import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

export type TelegramStatus = {
  configured: boolean;
  linked: boolean;
  botUsername: string | null;
};

export function telegramStatusQueryOptions() {
  return queryOptions({
    queryKey: ["telegram", "status"] as const,
    queryFn: async (): Promise<TelegramStatus> => {
      const response = await client("/api/telegram/status", {
        fallback: "Telegram status could not be loaded.",
      });
      return response.json();
    },
  });
}

export function telegramLinkMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<{
      code: string;
      link: string;
      expiresAt: string;
    }> => {
      const response = await client("/api/telegram/link", {
        method: "POST",
        fallback: "A link code could not be made.",
      });
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["telegram"] });
    },
  });
}

export function telegramUnlinkMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<{ ok: boolean }> => {
      const response = await client("/api/telegram/unlink", {
        method: "POST",
        fallback: "Could not unlink Telegram.",
      });
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["telegram"] });
    },
  });
}

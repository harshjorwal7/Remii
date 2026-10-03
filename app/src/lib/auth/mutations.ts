import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";

async function signOut(): Promise<{ redirectUrl: string | null }> {
  const response = await client("/api/auth/sign-out", {
    method: "POST",
    fallback: "Could not sign out",
  });
  const body = (await response.json().catch(() => null)) as {
    url?: unknown;
    redirectUrl?: unknown;
  } | null;
  const candidate =
    typeof body?.redirectUrl === "string"
      ? body.redirectUrl
      : typeof body?.url === "string"
        ? body.url
        : null;
  return { redirectUrl: candidate };
}

export function signOutMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: signOut,
    onSuccess: () => {
      queryClient.clear();
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith("remii.bot-thread.")) {
          window.localStorage.removeItem(key);
        }
      }
    },
  });
}

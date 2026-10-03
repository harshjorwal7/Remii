import { createRouter } from "@tanstack/react-router";
import { MaintenanceCrashScreen } from "./components/ui/maintenance-crash-screen";
import type { RouterContext } from "./router-context";
import { routeTree } from "./routeTree.gen";

export const router = createRouter({
  routeTree,
  defaultErrorComponent: ({ reset }) => (
    <MaintenanceCrashScreen
      onRetry={() => {
        reset();
        window.location.reload();
      }}
    />
  ),
  context: {} as RouterContext,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

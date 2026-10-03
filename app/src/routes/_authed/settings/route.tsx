import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";

export const Route = createFileRoute("/_authed/settings")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarShell width="300px">
      <SettingsSidebar />
      {/*
       * `min-w-0 min-h-0 overflow-hidden`.
       *
       * A flex item's automatic minimum size is its content's, so one wide table, `<pre>` or
       * unwrappable string in Settings stretched `main` past the viewport and pushed the whole
       * `SidebarShell` row wider than the window instead of scrolling inside it. `_app.tsx` gets
       * this from its own `overflow-hidden`; Settings had no such guard of its own.
       */}
      <main className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <Outlet />
      </main>
    </SidebarShell>
  );
}

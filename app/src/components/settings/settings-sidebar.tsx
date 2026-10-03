import {
  IconArrowLeft,
  IconBrain,
  IconClock,
  IconCreditCard,
  IconDeviceDesktop,
  IconFiles,
  IconLayoutGrid,
  IconListCheck,
  IconLock,
  IconPlug,
  IconSend,
  IconSettings,
  IconShieldCheck,
} from "@tabler/icons-react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";

const appLinkOptions = { to: "/" } satisfies LinkOptions;

const ITEMS: {
  /**
   * Whether this entry lights only on its own route.
   *
   * On for an entry whose path is a prefix of another's, which is the only reason to want it. Off
   * everywhere else, so an entry stays lit on the pages beneath it.
   */
  exact?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  linkOptions: LinkOptions;
  title: string;
}[] = [
  {
    title: "General",
    icon: IconSettings,
    /* `/settings` prefixes every other route here, and would otherwise light up on all of them. */
    exact: true,
    linkOptions: { to: "/settings" },
  },
  {
    title: "Billing & Credits",
    icon: IconCreditCard,
    linkOptions: { to: "/settings/billing" },
  },
  {
    title: "Action Boundaries",
    icon: IconShieldCheck,
    linkOptions: { to: "/settings/boundaries" },
  },
  {
    /*
     * What this deployment may reach as you. Connect new apps here,
     * or directly in chat.
     */
    title: "App connections",
    icon: IconPlug,
    linkOptions: { to: "/settings/connected-accounts" },
  },
  {
    title: "Telegram",
    icon: IconSend,
    linkOptions: { to: "/settings/telegram" },
  },
  {
    title: "Memory",
    icon: IconBrain,
    linkOptions: { to: "/settings/memory" },
  },
  {
    title: "Files",
    icon: IconFiles,
    linkOptions: { to: "/settings/files" },
  },
  {
    /*
     * What a Bot may log in with, pay with, and be told about you. Placed after Files because it is
     * the other half of what a coworker knows about its person: Files holds what it was given, this
     * holds what it is allowed to reach for.
     */
    title: "Vault",
    icon: IconLock,
    linkOptions: { to: "/settings/vault" },
  },
  {
    /*
     * Where the computer is, rather than a panel inside one conversation. Watching a Bot
     * you happen to be chatting with is not the same as having a computer you can go to.
     */
    title: "Computer",
    icon: IconDeviceDesktop,
    linkOptions: { to: "/settings/computer" },
  },
  {
    title: "Tasks",
    icon: IconListCheck,
    linkOptions: { to: "/settings/tasks" },
  },
  {
    title: "Schedules",
    icon: IconClock,
    linkOptions: { to: "/settings/schedules" },
  },
  {
    /* The same mark the Components gallery uses. It is the same subject seen from the other side. */
    title: "Components gallery",
    icon: IconLayoutGrid,
    linkOptions: { to: "/settings/components-gallery" },
  },
];

export function SettingsSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar {...props}>
      {/* Matched to the app sidebar's header height. */}
      <SidebarHeader className="h-12 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  <IconArrowLeft className="mr-2 h-4 w-4" />
                  Back to app
                </Link>
              )}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {/*
         * Group outside menu, as Admin has it. The other way round nests a list item inside a div
         * inside the `ul`, which is not markup a list is allowed to be made of.
         */}
        <SidebarGroup>
          <SidebarMenu className="gap-px">
            {ITEMS.map((option) => (
              <SidebarMenuItem key={option.title}>
                <SidebarMenuButton
                  render={(props) => (
                    <Link
                      {...option.linkOptions}
                      activeOptions={{ exact: option.exact ?? false }}
                      activeProps={{ className: "bg-foreground/5" }}
                      {...props}
                    >
                      <option.icon className="mr-2 h-4 w-4" />
                      {option.title}
                    </Link>
                  )}
                />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

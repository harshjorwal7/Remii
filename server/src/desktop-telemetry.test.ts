import { describe, expect, test } from "bun:test";
import { desktopTelemetryProperties } from "./desktop-telemetry";

describe("desktop runtime metadata", () => {
  test("leaves ordinary server deployments untagged", () => {
    expect(desktopTelemetryProperties({})).toEqual({});
    expect(
      desktopTelemetryProperties({ REMII_DISTRIBUTION: "server" }),
    ).toEqual({});
  });

  test("carries only the shell's bounded metadata", () => {
    expect(
      desktopTelemetryProperties({
        REMII_DISTRIBUTION: "desktop",
        REMII_VERSION: "0.0.9",
        REMII_PLATFORM: "macos",
        REMII_ARCH: "aarch64",
        REMII_OS_VERSION: "15.6.1",
        REMII_ENGINE: "podman",
        OPENAI_API_KEY: "synthetic-secret",
        CPK_TELEMETRY_ID: "identity-belongs-in-the-transport",
        HOME: "/Users/private-name",
        REMII_BASE_URL: "https://private.example",
      }),
    ).toEqual({
      remii_distribution: "desktop",
      remii_version: "0.0.9",
      remii_platform: "macos",
      remii_arch: "aarch64",
      remii_os_version: "15.6.1",
      remii_engine: "podman",
    });
  });

  test.each([
    "/Users/private-name",
    "private.example",
    "1.2-private-name",
    "1.2\nsecret",
    "1.2\n",
    "1.2.3.4.5",
    "1".repeat(40),
  ])("rejects arbitrary text in every metadata field: %s", (value) => {
    expect(
      desktopTelemetryProperties({
        REMII_DISTRIBUTION: "desktop",
        REMII_VERSION: value,
        REMII_OS_VERSION: value,
        REMII_PLATFORM: value,
        REMII_ARCH: value,
        REMII_ENGINE: value,
      }),
    ).toEqual({ remii_distribution: "desktop" });
  });
});

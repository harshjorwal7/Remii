/** Only the desktop shell's closed metadata may join the runtime's existing events. */
export function desktopTelemetryProperties(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (
    env.REMII_DISTRIBUTION !== "desktop" &&
    env.OPENBOT_DISTRIBUTION !== "desktop"
  )
    return {};

  const properties: Record<string, string> = {
    remii_distribution: "desktop",
  };
  for (const [input, legacy, output, allowed] of [
    [
      "REMII_PLATFORM",
      "OPENBOT_PLATFORM",
      "remii_platform",
      ["macos", "windows", "linux", "other"],
    ],
    [
      "REMII_ARCH",
      "OPENBOT_ARCH",
      "remii_arch",
      ["aarch64", "x86_64", "other"],
    ],
    [
      "REMII_ENGINE",
      "OPENBOT_ENGINE",
      "remii_engine",
      ["docker", "podman", "none"],
    ],
  ] as const) {
    const value = env[input] ?? env[legacy];
    if (value && allowed.some((item) => item === value))
      properties[output] = value;
  }
  for (const [input, legacy, output] of [
    ["REMII_VERSION", "OPENBOT_VERSION", "remii_version"],
    ["REMII_OS_VERSION", "OPENBOT_OS_VERSION", "remii_os_version"],
  ] as const) {
    const value = env[input] ?? env[legacy];
    if (
      value &&
      value.length <= 32 &&
      value.trim() === value &&
      /^\d+(?:\.\d+){1,3}$/.test(value)
    ) {
      properties[output] = value;
    }
  }
  return properties;
}

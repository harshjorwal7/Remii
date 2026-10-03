type BuiltInAgent = {
  id: string;
  name: string;
  type: "built_in";
  credentialRef: string;
};
type RemoteAgent = {
  id: string;
  name: string;
  /**
   * How the endpoint is dialled. Both kinds are an address this deployment posts a run to, and both
   * are available on the same condition, which is why availability below does not branch on it.
   *
   * Every address here comes from deployment configuration or the tenant package — the Bot this
   * deployment ships in the box, or the harness chosen at setup. A person cannot add one, so the
   * check below reports a broken deployment rather than guarding a boundary.
   */
  type: "remote_ag_ui" | "remote_mastra";
  endpoint: string;
};
type SeededAgent = BuiltInAgent | RemoteAgent;

export function createAgentRegistry(
  agents: SeededAgent[],
  activeCredentials: Set<string>,
) {
  return agents.map((agent) => {
    if (agent.type === "built_in") {
      return activeCredentials.has(agent.credentialRef)
        ? { id: agent.id, name: agent.name, type: agent.type, available: true }
        : {
            id: agent.id,
            name: agent.name,
            type: agent.type,
            available: false,
            reason: "Model credential is not configured.",
          };
    }
    const available = isHttpUrl(agent.endpoint);
    return available
      ? { id: agent.id, name: agent.name, type: agent.type, available: true }
      : {
          id: agent.id,
          name: agent.name,
          type: agent.type,
          available: false,
          reason: "AG-UI endpoint is invalid.",
        };
  });
}

function isHttpUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

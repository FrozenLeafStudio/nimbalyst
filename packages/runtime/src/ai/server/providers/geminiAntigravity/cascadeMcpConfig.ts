/**
 * cascadeMcpConfig.
 *
 * Phase 2A step 6 of `gemini-power-parity.md` section 6: build the
 * `McpServerSpec` fragment that exposes Nimbalyst's MCP endpoints to a
 * Cascade turn.
 *
 * [LIVE] Confirmed in `cascade-spike/step3-mcp-results.md` (probes
 * mcp7/mcp8, 2026-09-13): sending `McpServerSpec[]` under
 * `SendUserCascadeMessageRequest.cascadeConfig.plannerConfig
 * .customizationDiscoveryConfig.mcp.servers` on a turn made a real
 * `### nimbalyst` tool group (3 tools: `capture_editor_screenshot`,
 * `display_to_user`, `update_session_meta`) and the `call_mcp_tool` gateway
 * appear in the model's own next-turn tool listing -- a genuine MCP
 * handshake against Nimbalyst's `/mcp/core` endpoint, not a schema no-op or
 * hallucination (the tool names aren't guessable).
 *
 * [DESCRIPTOR-ONLY / proven dead] The same `McpServerSpec` shape under
 * `StartCascadeRequest.customAgentSpec.launchedMcpServers` (probe mcp4a) was
 * accepted with a 200 but had zero observable effect -- no tool group
 * appeared on the next turn and `GetMcpServerStates` stayed `{}` before and
 * after. Do not register servers this way; kept only as a documented dead
 * end so it isn't rediscovered.
 *
 * `McpServerSpec` field names (`serverName`/`serverUrl`/`headers`) are
 * identical across both parent paths; only the parent object differs.
 * Copied verbatim from the probe request/response, not the proto schema.
 *
 * This module never reads `mcp-endpoint.json` -- that file lives under an
 * Electron-specific app-data directory and this package must stay
 * platform-agnostic (works in Electron and Capacitor/mobile). Callers
 * resolve url/bearerToken/serverName themselves and pass them in, the same
 * way `GeminiAntigravityProvider.setServerConfigLoader` injects other
 * environment-specific settings.
 */

export interface McpServerSpec {
  serverName: string;
  serverUrl: string;
  headers: Record<string, string>;
}

export interface McpEndpointInput {
  /** Identifies the server in the model's tool listing, e.g. "nimbalyst". */
  serverName: string;
  /** Streamable HTTP URL for the endpoint, without the bearer token applied yet. */
  url: string;
  bearerToken: string;
}

/**
 * Append `token=<bearerToken>` to `url`'s query string without disturbing
 * existing params. The live-proven request (mcp7) carried the token both as
 * this query param and as the `Authorization` header below -- per
 * `mcp-and-prompt.md`, which of the two Antigravity's parser actually keeps
 * is unverified, so both are sent, matching the config that was confirmed
 * working end to end.
 */
function appendTokenParam(url: string, bearerToken: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(bearerToken)}`;
}

export function buildMcpServerSpec(endpoint: McpEndpointInput): McpServerSpec {
  return {
    serverName: endpoint.serverName,
    serverUrl: appendTokenParam(endpoint.url, endpoint.bearerToken),
    headers: { Authorization: `Bearer ${endpoint.bearerToken}` },
  };
}

/**
 * [LIVE] The `customizationDiscoveryConfig` fragment for
 * `cascadeConfig.plannerConfig.customizationDiscoveryConfig` on every
 * `SendUserCascadeMessage` -- the proven-live parent path (see file header).
 * One `McpServerSpec` per Nimbalyst endpoint (core, and later
 * trackers/situational per the plan's "Next" note).
 */
export function buildMcpServersConfig(endpoints: McpEndpointInput[]): {
  mcp: { servers: McpServerSpec[] };
} {
  return { mcp: { servers: endpoints.map(buildMcpServerSpec) } };
}

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildMcpServerSpec, buildMcpServersConfig } from '../cascadeMcpConfig';

// Fixture copied verbatim from cascade-spike/step3-mcp-results.md's mcp7
// request (customizationDiscoveryConfig.mcp.servers, the proven-live path).
// The `url` here is the evidence's serverUrl minus the trailing
// `&token=__NIM_TOKEN__`, since this module appends the token itself.
const ENDPOINT = {
  serverName: 'nimbalyst',
  url:
    'http://127.0.0.1:3456/mcp/core?workspacePath=C%3A%5CUsers%5Csteph%5CDocuments%5CSoftware%20Dev%5CWorkspace%5Crandomshit',
  bearerToken: '__NIM_TOKEN__',
};

const EXPECTED_SERVER_URL =
  'http://127.0.0.1:3456/mcp/core?workspacePath=C%3A%5CUsers%5Csteph%5CDocuments%5CSoftware%20Dev%5CWorkspace%5Crandomshit&token=__NIM_TOKEN__';

describe('buildMcpServerSpec', () => {
  it('matches the exact live-proven McpServerSpec shape', () => {
    expect(buildMcpServerSpec(ENDPOINT)).toEqual({
      serverName: 'nimbalyst',
      serverUrl: EXPECTED_SERVER_URL,
      headers: { Authorization: 'Bearer __NIM_TOKEN__' },
    });
  });

  it('appends the token query param with a ? when the url has no existing query string', () => {
    const spec = buildMcpServerSpec({ serverName: 'x', url: 'http://127.0.0.1:3456/mcp/core', bearerToken: 't' });
    expect(spec.serverUrl).toBe('http://127.0.0.1:3456/mcp/core?token=t');
  });
});

describe('buildMcpServersConfig', () => {
  it('nests one spec per endpoint under mcp.servers, matching the customizationDiscoveryConfig fragment', () => {
    expect(buildMcpServersConfig([ENDPOINT])).toEqual({
      mcp: {
        servers: [
          {
            serverName: 'nimbalyst',
            serverUrl: EXPECTED_SERVER_URL,
            headers: { Authorization: 'Bearer __NIM_TOKEN__' },
          },
        ],
      },
    });
  });

  it('handles multiple endpoints for the "next" host/trackers/situational rollout', () => {
    const result = buildMcpServersConfig([
      ENDPOINT,
      { serverName: 'nimbalyst-trackers', url: 'http://127.0.0.1:3456/mcp/trackers', bearerToken: 'tok2' },
    ]);
    expect(result.mcp.servers).toHaveLength(2);
    expect(result.mcp.servers[1]).toEqual({
      serverName: 'nimbalyst-trackers',
      serverUrl: 'http://127.0.0.1:3456/mcp/trackers?token=tok2',
      headers: { Authorization: 'Bearer tok2' },
    });
  });
});

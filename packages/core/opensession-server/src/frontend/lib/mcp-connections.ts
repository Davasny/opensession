import type { McpValueUpdate } from "./mcp-form";

export interface McpConnection {
  name: string;
  transport: "http" | "stdio";
  target: string;
  /** stdio: the executable and args the edit form prefills. */
  command?: string;
  args?: string[];
  /** http: the stored URL without its query string, which may carry a token. */
  url?: string;
  /** http: a query string is stored and survives an edit that omits one. */
  urlHasQuery?: boolean;
  /** http: configured header names. Values are never exposed. */
  headerNames?: string[];
  envKeys: string[];
  status:
    | "connected"
    | "ready"
    | "needs-env"
    | "needs-auth"
    | "unreachable"
    | "missing";
  detail?: string;
  /** Per-user allowlist, if this server is restricted (absent = everyone). */
  allowedUsers?: string[];
}

/** The PUT body for editing a configured server. Fields omitted are left as
 *  they are; header/env rows with a null value keep their stored value. */
export interface McpServerUpdateInput {
  url?: string;
  command?: string;
  args?: string[];
  headers?: McpValueUpdate[];
  env?: McpValueUpdate[];
  allowedUsers: string[];
}

const TOKEN_CONNECT_URL_VALUES = {
  vercel: {
    url: "https://vercel.com/account/settings/tokens",
    label: "vercel.com/account/settings/tokens",
  },
  vero: {
    url: "https://help.getvero.com/vero-ai/mcp-authentication",
    label: "Vero's MCP authentication guide",
  },
  oneleet: {
    url: "https://docs.oneleet.com/api-and-mcp/connecting-ai-assistants-with-oauth/",
    label: "Oneleet's MCP connection guide",
  },
} satisfies Readonly<Record<string, { url: string; label: string }>>;

export const TOKEN_CONNECT_URLS = Object.fromEntries(
  Object.entries(TOKEN_CONNECT_URL_VALUES),
);

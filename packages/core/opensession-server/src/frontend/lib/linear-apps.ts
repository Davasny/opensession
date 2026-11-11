import { z } from "zod";
import { request } from "./api/request";

export const linearAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  clientId: z.string(),
  clientSecretConfigured: z.boolean(),
  webhookConfigured: z.boolean(),
  authorizeUrl: z.string(),
  callbackUrl: z.string(),
  webhookUrl: z.string(),
  automationEventKey: z.string(),
  automation: z
    .object({
      id: z.string(),
      prompt: z.string(),
      mode: z.enum(["scratch", "ask", "code"]),
      model: z.string().nullish(),
      effort: z.string().nullish(),
      mcpServers: z.array(z.string()).nullish(),
      mcpAll: z.boolean().optional(),
      enabled: z.boolean(),
      repo: z.string().nullish(),
    })
    .nullable(),
});
export type LinearApp = z.infer<typeof linearAppSchema>;

interface LinearAppCredentialUpdate {
  name: string;
  oauthClientId: string;
  oauthClientSecret?: string;
  webhookSecret?: string;
}

export async function fetchLinearApps() {
  return z.object({ apps: z.array(linearAppSchema) }).parse(
    await request<unknown>("/connections/linear/apps", {
      label: "Could not load Linear apps",
    }),
  ).apps;
}

export function linearAppCredentials(input: {
  name: string;
  oauthClientId: string;
  oauthClientSecret: string;
  webhookSecret: string;
}) {
  const credentials: LinearAppCredentialUpdate = {
    name: input.name.trim(),
    oauthClientId: input.oauthClientId.trim(),
  };
  if (input.oauthClientSecret.trim())
    credentials.oauthClientSecret = input.oauthClientSecret.trim();
  if (input.webhookSecret.trim())
    credentials.webhookSecret = input.webhookSecret.trim();
  return credentials;
}

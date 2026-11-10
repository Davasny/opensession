import { z } from "zod";
import { request } from "./api/request";

export const automationLinearConnectionSchema = z.object({
  appId: z.string().min(1),
  organizationId: z.string().min(1),
});

export type AutomationLinearConnection = z.infer<
  typeof automationLinearConnectionSchema
>;

const connectionOptionSchema = automationLinearConnectionSchema.extend({
  appName: z.string(),
  organizationName: z.string().optional(),
});

export type AutomationLinearConnectionOption = z.infer<
  typeof connectionOptionSchema
>;

export const linearConnectionKey = (connection: AutomationLinearConnection) =>
  JSON.stringify([connection.appId, connection.organizationId]);

export const linearConnectionLabel = (
  connection: AutomationLinearConnectionOption,
) =>
  `${connection.appName} · ${connection.organizationName || connection.organizationId}`;

export const fetchAutomationLinearConnections = async () => {
  const result = await request<unknown>("/automations/linear-connections", {
    label: "Could not load Linear connections",
  });
  return z
    .object({ connections: z.array(connectionOptionSchema) })
    .parse(result).connections;
};

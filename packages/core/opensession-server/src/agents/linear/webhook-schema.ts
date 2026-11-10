import { z } from "zod";

const optionalText = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);

const issueSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string(),
  description: optionalText,
  url: z.string(),
});

export const agentSessionWebhookSchema = z.object({
  type: z
    .enum(["AgentSession", "AgentSessionEvent"])
    .transform((): "AgentSession" => "AgentSession"),
  action: z.enum(["created", "updated", "ended", "dismissed", "prompted"]),
  organizationId: z.string().min(1),
  actor: z.object({ id: z.string(), name: z.string() }).optional(),
  agentSession: z.object({
    id: z.string().min(1),
    status: z.string(),
    createdAt: z.string().optional(),
    issue: issueSchema,
    comments: z
      .array(z.object({ id: z.string(), body: z.string() }))
      .optional(),
  }),
  agentActivity: z
    .object({
      id: z.string().optional(),
      createdAt: z.string().optional(),
      signal: optionalText,
      userId: optionalText,
      content: z.object({ type: z.string(), body: z.string() }).optional(),
    })
    .optional(),
});

export const issueWebhookSchema = z.object({
  type: z.literal("Issue"),
  action: z.enum(["create", "update", "remove"]),
  organizationId: z.string().min(1),
  data: issueSchema.extend({
    stateId: optionalText,
    assigneeId: optionalText,
  }),
  updatedFrom: z
    .object({
      stateId: optionalText,
      assigneeId: optionalText,
    })
    .optional(),
});

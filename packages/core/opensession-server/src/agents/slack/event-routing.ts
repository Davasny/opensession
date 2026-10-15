type SlackEvent = {
  type?: string;
  subtype?: string;
  bot_id?: string;
  [key: string]: unknown;
};

export function shouldHandleAppMention(event: SlackEvent): boolean {
  return event.type === "app_mention" && !event.subtype && !event.bot_id;
}

export function shouldHandleDirectMessage(event: SlackEvent): boolean {
  return (
    event.type === "message" &&
    event.channel_type === "im" &&
    event.user !== "USLACK" &&
    !event.bot_id
  );
}

/**
 * Who sent a Slack event or interaction, as far as the workspace boundary is
 * concerned. `homeTeamId` is our own workspace (auth.test); `rosterSlackIds`
 * are the configured teammates, who are trusted even when Slack reports a
 * different team for them.
 */
export type SlackSenderCheck = {
  userId?: string | null;
  senderTeamId?: string | null;
  homeTeamId?: string | null;
  /** Slack's `is_ext_shared_channel` for the event, when known. */
  sharedChannel?: boolean;
  isRosterMember: (slackId: string) => boolean;
};

/**
 * True when the sender belongs to another Slack workspace (a Slack Connect
 * partner in a shared channel). Such senders must not start, steer, or answer
 * sessions: a session runs with this server's access. A sender with no team
 * on the event is treated as external only in a shared channel, where the
 * bot cannot tell who posted.
 */
export function isExternalSlackSender(check: SlackSenderCheck): boolean {
  if (check.userId && check.isRosterMember(check.userId)) return false;
  const sender = check.senderTeamId || "";
  const home = check.homeTeamId || "";
  if (sender && home) return sender !== home;
  return check.sharedChannel === true;
}

/** The sender's team on an Events API event (message, app_mention, ...). */
export function slackEventSenderTeam(event: SlackEvent): string | null {
  const profile = event.user_profile as { team?: unknown } | undefined;
  for (const value of [event.user_team, profile?.team, event.team]) {
    if (typeof value === "string" && value) return value;
  }
  return null;
}

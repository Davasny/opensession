import { describe, expect, test } from "bun:test";
import {
  shouldHandleAppMention,
  shouldHandleDirectMessage,
  isExternalSlackSender,
  slackEventSenderTeam,
} from "./event-routing";

describe("shouldHandleAppMention", () => {
  test("handles user mentions", () => {
    expect(
      shouldHandleAppMention({
        type: "app_mention",
        user: "U123",
        text: "<@U999> help",
      }),
    ).toBe(true);
  });

  test("ignores channel archive system messages", () => {
    expect(
      shouldHandleAppMention({
        type: "app_mention",
        subtype: "channel_archive",
        user: "U999",
        text: "<@U999> archived the channel <#C123>",
      }),
    ).toBe(false);
  });

  test("ignores other app mention system messages", () => {
    expect(
      shouldHandleAppMention({
        type: "app_mention",
        subtype: "channel_unarchive",
        user: "U999",
        text: "<@U999> unarchived the channel <#C123>",
      }),
    ).toBe(false);
  });
});

describe("shouldHandleDirectMessage", () => {
  test("handles user messages", () => {
    expect(
      shouldHandleDirectMessage({
        type: "message",
        channel_type: "im",
        user: "U123",
        text: "Help",
      }),
    ).toBe(true);
  });

  test("handles user file shares", () => {
    expect(
      shouldHandleDirectMessage({
        type: "message",
        subtype: "file_share",
        channel_type: "im",
        user: "U123",
      }),
    ).toBe(true);
  });

  test("ignores Slack channel archive messages", () => {
    expect(
      shouldHandleDirectMessage({
        type: "message",
        subtype: "channel_archive",
        channel_type: "im",
        user: "USLACK",
        text: "<@U999> archived the channel <#C123>",
      }),
    ).toBe(false);
  });

  test("ignores bot messages", () => {
    expect(
      shouldHandleDirectMessage({
        type: "message",
        channel_type: "im",
        user: "U123",
        bot_id: "B123",
      }),
    ).toBe(false);
  });
});

describe("isExternalSlackSender", () => {
  const roster = new Set(["UTEAM"]);
  const isRosterMember = (id: string) => roster.has(id);

  test("allows senders from our own workspace", () => {
    expect(
      isExternalSlackSender({
        userId: "U1",
        senderTeamId: "THOME",
        homeTeamId: "THOME",
        isRosterMember,
      }),
    ).toBe(false);
  });

  test("blocks senders from another workspace", () => {
    expect(
      isExternalSlackSender({
        userId: "U2",
        senderTeamId: "TOTHER",
        homeTeamId: "THOME",
        sharedChannel: true,
        isRosterMember,
      }),
    ).toBe(true);
  });

  test("allows teammates with an account whatever workspace they are in", () => {
    expect(
      isExternalSlackSender({
        userId: "UTEAM",
        senderTeamId: "TOTHER",
        homeTeamId: "THOME",
        sharedChannel: true,
        isRosterMember,
      }),
    ).toBe(false);
  });

  test("blocks an unknown team only in a shared channel", () => {
    const base = { userId: "U3", homeTeamId: "THOME", isRosterMember };
    expect(isExternalSlackSender({ ...base, sharedChannel: true })).toBe(true);
    expect(isExternalSlackSender({ ...base, sharedChannel: false })).toBe(
      false,
    );
  });
});

describe("slackEventSenderTeam", () => {
  test("prefers user_team, then the profile team, then team", () => {
    expect(slackEventSenderTeam({ user_team: "TA", team: "TB" })).toBe("TA");
    expect(
      slackEventSenderTeam({ user_profile: { team: "TC" }, team: "TB" }),
    ).toBe("TC");
    expect(slackEventSenderTeam({ team: "TB" })).toBe("TB");
    expect(slackEventSenderTeam({})).toBeNull();
  });
});

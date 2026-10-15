import { useEffect, useRef, useState } from "react";
import type { SessionBuildWire } from "@tellahq/opensession-protocol/session";
import { BASE_PATH } from "../lib/base";
import { checkToneClass } from "../lib/pr-checks";
import {
  buildGroupUrl,
  buildVisual,
  hiddenBuildGroupKeys,
  isBuildLive,
  hideBuildGroup,
  hideKey,
  visibleBuildGroups,
  type BuildGroup,
  type RolloutApp,
} from "../lib/session-builds";
import { SCRIPT_CARD_SHELL } from "../lib/script-card-classes";
import { elapsedSince, formatDuration } from "../lib/time";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Tooltip } from "../ui/tooltip";
import { CheckStatusIcon } from "./CheckStatusIcon";
import { IconX } from "./icons";

const RESYNC_WHILE_LIVE_MS = 60_000;

/**
 * GitHub Actions runs and rollouts the session follows (server/
 * session-builds.ts): the CI of its branch and, once its PR merged, the
 * deploy of the merge commit. Fed from webhooks by the server, so the card
 * loads the list on mount and follows `session_builds` frames.
 *
 * Frames are not replayed: one sent while the socket was down, or while the
 * tab slept, is gone. So the card loads the list again on every reconnect,
 * when the tab comes back into view, and now and then while a build runs.
 */
export function BuildsCard({
  sessionId,
  connected,
}: {
  sessionId: string;
  connected: boolean;
}) {
  const { addHandler } = useSessionSocket();
  const [builds, setBuilds] = useState<SessionBuildWire[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [hidden, setHidden] = useState(() => hiddenBuildGroupKeys());
  const [reloads, setReloads] = useState(0);
  // Bumped by every frame: a load that started before a frame arrived is
  // older than what the card shows and must not replace it.
  const frameSeq = useRef(0);

  useEffect(() => {
    setBuilds([]);
    const off = addHandler((message) => {
      if (
        message.type === "session_builds" &&
        message.sessionId === sessionId
      ) {
        frameSeq.current++;
        setBuilds(message.builds);
      }
    });
    return off;
  }, [sessionId, addHandler]);

  useEffect(() => {
    if (!connected) return;
    let live = true;
    const seq = frameSeq.current;
    fetch(`${BASE_PATH}/api/builds?sessionId=${encodeURIComponent(sessionId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (live && body?.builds && seq === frameSeq.current)
          setBuilds(body.builds);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sessionId, connected, reloads]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setReloads((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const groups = visibleBuildGroups(builds, hidden, now);
  const anyLive = groups.some((g) => g.live);

  // A missed final frame would leave a build running forever: while one
  // runs, check the list once a minute.
  useEffect(() => {
    if (!anyLive || !connected) return;
    const timer = setInterval(
      () => setReloads((n) => n + 1),
      RESYNC_WHILE_LIVE_MS,
    );
    return () => clearInterval(timer);
  }, [anyLive, connected]);

  // One clock for every row: elapsed time while running, and ended groups
  // leaving after their window.
  useEffect(() => {
    if (!builds.length) return;
    const timer = setInterval(
      () => setNow(Date.now()),
      anyLive ? 1_000 : 30_000,
    );
    return () => clearInterval(timer);
  }, [builds.length, anyLive]);

  if (!groups.length) return null;
  return (
    <div className="flex flex-col">
      {groups.map((group) => (
        <BuildGroupCard
          key={group.key}
          group={group}
          now={now}
          onHide={() => {
            hideBuildGroup(group);
            setHidden((prev) => new Set(prev).add(hideKey(group)));
          }}
        />
      ))}
    </div>
  );
}

function groupTitle(group: BuildGroup): string {
  const sha = group.sha.slice(0, 7);
  if (group.prNumber != null) {
    if (group.live) return `Deploying PR #${group.prNumber}`;
    return group.failed
      ? `Deploy of PR #${group.prNumber} failed`
      : `PR #${group.prNumber} deployed`;
  }
  if (group.live) return `Building ${sha}`;
  return group.failed ? `Build failed on ${sha}` : `Build passed on ${sha}`;
}

function groupSummary(group: BuildGroup): string {
  const rows = [
    ...group.workflows,
    ...group.rollouts.flatMap((a) => a.targets),
  ];
  const count = (pred: (r: SessionBuildWire) => boolean) =>
    rows.filter(pred).length;
  const parts = [
    [count((r) => r.state === "failure"), "failed"],
    [count((r) => r.state === "running" || r.state === "queued"), "running"],
    [count((r) => r.state === "success"), "passed"],
    [count((r) => r.state === "cancelled"), "cancelled"],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(" · ");
}

function BuildGroupCard({
  group,
  now,
  onHide,
}: {
  group: BuildGroup;
  now: number;
  onHide: () => void;
}) {
  const title = groupTitle(group);
  const visual = group.live ? "pending" : group.failed ? "failure" : "success";
  return (
    <section className={SCRIPT_CARD_SHELL} aria-label={title}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={cn("shrink-0", checkToneClass(visual))}>
          <CheckStatusIcon kind={visual} />
        </span>
        <a
          href={buildGroupUrl(group)}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 truncate text-label font-semibold text-fg no-underline hover:underline"
        >
          {title}
        </a>
        <span className="shrink-0 text-meta text-dim tabular-nums phone:hidden">
          {groupSummary(group)}
        </span>
        <Tooltip label="Close" side="top">
          <Button
            variant="ghost"
            size="sm"
            className="-my-1 -mr-1.5 shrink-0 phone:min-h-11 phone:min-w-11"
            icon={<IconX size={16} />}
            aria-label="Close"
            onClick={onHide}
          />
        </Tooltip>
      </div>

      {group.workflows.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {group.workflows.map((run) => (
            <WorkflowRow key={run.id} run={run} now={now} />
          ))}
        </ul>
      )}

      {group.rollouts.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-meta font-medium text-dim">Rollouts</span>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {group.rollouts.map((app) => (
              <RolloutRow key={app.app} app={app} now={now} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function workflowStatus(run: SessionBuildWire, now: number): string {
  const jobs = run.jobs ? `${run.jobs.done}/${run.jobs.total} jobs` : null;
  const took = run.endedAt
    ? formatDuration(Date.parse(run.endedAt) - Date.parse(run.startedAt))
    : null;
  switch (run.state) {
    case "queued":
      return "Queued";
    case "running":
      return ["Running", jobs, elapsedSince(Date.parse(run.startedAt), now)]
        .filter(Boolean)
        .join(" · ");
    case "success":
      return took ? `Passed in ${took}` : "Passed";
    case "cancelled":
      return "Cancelled";
    case "failure":
      return took ? `Failed after ${took}` : "Failed";
  }
}

function ExternalTitle({ url, text }: { url?: string; text: string }) {
  if (!url)
    return (
      <span className="min-w-0 truncate text-supporting text-fg">{text}</span>
    );
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="min-w-0 truncate text-supporting text-fg no-underline hover:underline"
    >
      {text}
    </a>
  );
}

function WorkflowRow({ run, now }: { run: SessionBuildWire; now: number }) {
  const visual = buildVisual(run.state);
  // Show the failed job as soon as one fails, before the run ends.
  const failedDetail =
    run.detail && (run.state === "failure" || (run.jobs?.failed ?? 0) > 0)
      ? run.detail
      : null;
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("shrink-0", checkToneClass(visual))}>
          <CheckStatusIcon kind={visual} />
        </span>
        <ExternalTitle url={run.url} text={run.title} />
        <span className="ml-auto shrink-0 text-meta text-dim tabular-nums">
          {workflowStatus(run, now)}
        </span>
      </div>
      {failedDetail && (
        <p className="m-0 pl-6 text-meta text-red [overflow-wrap:anywhere]">
          {failedDetail}
        </p>
      )}
    </li>
  );
}

function RolloutRow({ app, now }: { app: RolloutApp; now: number }) {
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="min-w-0 truncate text-supporting text-fg">
        {app.app}
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-1.5">
        {app.targets.map((target) => (
          <RolloutTarget key={target.id} target={target} now={now} />
        ))}
      </span>
    </li>
  );
}

function RolloutTarget({
  target,
  now,
}: {
  target: SessionBuildWire;
  now: number;
}) {
  const stale = target.state === "running" && !isBuildLive(target, now);
  const visual = stale ? "neutral" : buildVisual(target.state);
  const pill = cn(
    "inline-flex items-center gap-1.5 rounded-full bg-hover px-2 py-0.5 text-meta text-dim no-underline",
    target.url && "hover:text-fg",
  );
  const body = (
    <>
      <span className={cn("shrink-0 scale-75", checkToneClass(visual))}>
        <CheckStatusIcon kind={visual} />
      </span>
      {target.target}
    </>
  );
  const label = stale
    ? `No result reported for ${target.title} on ${target.target}`
    : target.detail || `${target.title} on ${target.target}`;
  return (
    <Tooltip label={label} side="top">
      {target.url ? (
        <a
          href={target.url}
          target="_blank"
          rel="noreferrer"
          className={pill}
          aria-label={label}
        >
          {body}
        </a>
      ) : (
        <span className={pill} aria-label={label}>
          {body}
        </span>
      )}
    </Tooltip>
  );
}

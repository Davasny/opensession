# Linear

The Linear agent (`packages/core/opensession-server/src/agents/linear/`) turns
Linear agent-session assignments into Open Session sessions. Each OAuth app
can have its own instructions, model, reasoning effort, task mode, and MCP
connector allowlist.
For example, separate writing and testing apps can work in the same Linear
workspace without sharing their OAuth grants or instructions.

The legacy primary app uses `defaultRepo()` and the plan/implement/free-form
coding flow. Configured apps can select a repository, or use a general-task
workspace with no repository. There is no per-issue repository routing.

## Prerequisites

General-task agents need HTTPS ingress, but no repository or GitHub installation.
The repository, GitHub, and workflow-status requirements below apply to coding agents.

- Configure an HTTPS [public ingress](install.md#public-ingress). The OAuth state
  cookie is `Secure`, and the webhook and OAuth routes exist only on this
  gateway, normally port 3860 behind a TLS proxy.
- Configure the intended GitHub repository as the instance's default repo. For
  the branch-and-PR workflow, it must not use the live `sharedCheckout` path
  (unless instance `selfDev` is `"worktree"`). The Linear agent does not request
  an isolated checkout explicitly, so a shared-checkout default repo is edited
  in place and has no dedicated branch for the automatic PR.
- Give the Open Session GitHub App access to the default repository (contents
  and pull requests write). The final PR helper mints an installation token for
  that repository and fails closed, with a short reason in the session, when
  the App is not installed or cannot mint a token. Ambient `gh` authentication
  is not used for the automatic PR.
- The issue's Linear team should have workflow statuses named **Ready** and
  **In Progress**. Planning moves the issue to `Ready`; implementation moves it
  to and auto-starts from `In Progress`. Status matching is case-insensitive,
  but the names are otherwise exact.
- Configure the desired **Branch format** in Linear's GitHub/GitLab integration
  settings. Open Session creates the issue's `Issue.branchName` as-is, so the
  checkout matches the branch name Linear shows for the issue.

## Configuration

Open **Settings → Integrations → Linear** to configure the primary app or add
another OAuth app. App credentials are stored in the instance config and are
never returned by the settings API. Existing credentials in `~/.opensession.env`
remain supported for the primary app and take precedence over config.

Enable Linear and restart once to load the connector. Once it is running, app
configuration, OAuth connections, and instructions do not require a restart.

| Var                        | Required for              | Notes                                                                                    |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| `LINEAR_CLIENT_ID`         | OAuth                     | Linear OAuth app client ID                                                               |
| `LINEAR_CLIENT_SECRET`     | OAuth                     | authorization-code exchange and token refresh                                            |
| `LINEAR_WEBHOOK_SECRET`    | webhooks                  | HMAC secret; unset or empty rejects every webhook with 401                               |
| `ENABLE_LINEAR_AGENT`      | loading the agent         | optional env override; only the literal `true` enables, and any other set value disables |
| `LINEAR_API_KEY`           | optional external tooling | the Linear session agent uses OAuth, not this key                                        |
| `OPENSESSION_INGRESS_BASE` | optional global override  | public origin used by the default OAuth callback URL                                     |
| `OPENSESSION_UI_BASE`      | optional global override  | private app origin used for links added to Linear sessions                               |

The agent is off by default. If `ENABLE_LINEAR_AGENT` is unset, enable it with
`integrations.linear.enabled: true` in `~/.opensession/config.json`; the env flag
wins when present. See [boot guards](integrations-misc.md#boot-guards).
Restart Open Session after changing the enable flag. Env changes also require
a restart; app credentials saved in Settings are read live.

Each app sets its own assignment start under **Agent instructions and tools**:
`ask` keeps the greeting until a person replies `plan` or `implement`, `plan`
starts the planning interview as soon as the issue is assigned, and `implement`
starts implementation and moves the issue to **In Progress** without a reply.
Coding agents default to `ask`. General and read-only agents always start their
assigned task. Planning still waits for approval and moves the issue to
**Ready**; implementation remains gated by the existing workflow. The primary
app stores the setting as `integrations.linear.startMode`; additional apps store
it on their entry in `integrations.linear.apps`.

No personal API key is required to enable the connector.

### Multiple apps and agent instructions

The primary app keeps the existing config fields and URLs. Additional apps are
stored in `integrations.linear.apps`, following the GitHub app registry pattern.
Each has a stable local ID, optional name, OAuth client ID and secret, and webhook secret.
Set **App name (optional)** under **App name and credentials** to give an app a
recognizable label in automation connection pickers. In config, use
`integrations.linear.name` for the primary app or `name` on an additional app.
An omitted or blank name displays as `Linear`. Workspace IDs appear in the
picker only when needed to distinguish connections with the same name.
An app's client ID cannot be replaced once configured; create another app for a
different OAuth identity. Secrets can be rotated without changing the app ID.

From the Desk, ask which Linear connections are available. Its
`list_linear_connections` tool lists connected apps and workspaces with the
exact ids to pass as `linearConnection` when creating or updating an
automation. The tool returns display names and ids only, never tokens or client
secrets. Ids are always chosen explicitly; the Desk never substitutes another
app's credentials.

For each app, Settings shows the shared OAuth callback URL, that app's webhook
URL, and a **Connect** action. Register the callback in each Linear app's
Redirect URLs, register that app's webhook URL, then connect it to the intended
Linear workspace with `actor=app` authorization. Choose the corresponding app as
the agent in Linear to route work to it.

Agent settings reuse event automations, as GitHub review settings do. Each app
has the event key `linear:agent_session:<app-id>`. The connector owns dispatch
and conversation continuation; it reads the automation's prompt, model,
reasoning effort, enabled flag, and MCP allowlist for each turn. The app's
assignment start comes from the app record, not the automation. The primary app
keeps its legacy flow until agent settings are saved. New additional apps
default to general tasks with no external MCP connectors selected. **All
connectors** is an explicit choice; an empty list stays empty.

The app's own **linear** connector is always offered in agent settings. It uses
that app's Linear sign-in, needs no separate MCP server entry, and lets the
agent read or comment on issues. Other configured connectors remain additive.

- **General task** uses a durable scratch directory, without a repository,
  coding interview, automatic status changes, or automatic PR creation.
- **Repository read-only** uses the repository's ask checkout and ask-mode tools.
- **Coding** uses the existing planning and implementation flow, including PR
  creation after implementation completes.

Instructions and tool selection apply to the next turn. Task mode, assignment
start, and repository are locked when an assignment creates its workspace;
changing them affects new assignments. Disabling an app's automation prevents
new turns. Removing an app rejects its future webhook and authorization
requests; an already running turn may still finish. Removing it does not
uninstall the OAuth app in Linear.

## OAuth app setup

1. Create a Linear OAuth application and enable its app/agent actor capability.
2. Register the exact callback described below. Open Session requests scopes
   `app:assignable read write` with `actor: "app"`.
3. Set the client ID, client secret, and webhook secret. Enable the integration
   and restart Open Session if it is not already running. The routes are not
   registered while the connector is disabled.
4. Visit `<public-ingress-origin>/oauth/authorize` in a browser and approve the
   app in the Linear workspace. The callback stores the grant.
5. Configure Linear to send agent-session and issue events to
   `<public-ingress-origin>/webhook`.

OAuth routes:

- `GET /oauth/authorize` redirects to Linear's consent page.
- `GET /oauth/callback` exchanges the code for the app identified by the OAuth
  state. Primary-app grants are stored by organization in
  `~/.linear-agent-tokens.json`, written atomically and refreshed when an agent
  API call finds a token within five minutes of expiry.

The OAuth `redirect_uri` is `integrations.linear.oauthRedirectUrl` when that
value is non-empty. Otherwise it is
`<configuredServer().webhookBaseUrl>/oauth/callback`; that base resolves from
`OPENSESSION_INGRESS_BASE`, then `ingress.publicBaseUrl`, then the private app
origin. Every app uses this same URL, so register one HTTPS URL exactly,
including its scheme and path.

Additional apps use `GET /linear/oauth/<app-id>/authorize` and
`POST /linear/webhook/<app-id>`. Their app id travels in the OAuth state, so
their callbacks return through the shared `/oauth/callback`.
`GET /linear/oauth/<app-id>/callback` remains for authorizations that started
before the shared callback. Their tokens live under the state directory at
`linear-apps/<app-id>/tokens.json` with owner-only permissions. OAuth state
cookies and refresh locks are scoped to the app. A webhook is verified only
against the receiving app's secret.

Sessions persist both app and organization identity. Startup restoration and
replies select that exact grant. A legacy session without an organization may
use a fallback only when its app has exactly one stored organization.

### Linear MCP

The agent-session flow does not require an MCP server. The app's agent settings
offer a built-in `linear` connector that binds the MCP connection to that app
and organization after generic credential overlays; choosing **All connectors**
includes it too. A personal or primary-app grant cannot supersede that binding.
A missing grant fails closed, and a bound connection must use the official
HTTPS `mcp.linear.app` endpoint. When no canonical `linear` server is
configured, the logical mount uses `https://mcp.linear.app/mcp`. A configured
`linear` server remains authoritative, including its endpoint and
`allowedUsers` gate. Other interactive sessions keep the existing
personal/shared MCP credential behavior.

## Webhook intake and lifecycle

Linear signs the raw request body in the `linear-signature` header with
HMAC-SHA256. Open Session verifies it with `LINEAR_WEBHOOK_SECRET` using a
timing-safe comparison. Bodies over 1 MiB receive 413.

Consumed events (`packages/core/opensession-server/src/agents/linear/index.ts`
and `handlers.ts`):

- `AgentSessionEvent` / `AgentSession`:
  - `created` prepares the default repo, persists the session, files its
    workspace, and starts work according to the app's assignment start: `ask`
    posts the legacy greeting, while `plan` and `implement` start one automatic
    turn.
  - `prompted` runs planning, implementation, or a free-form coding turn.
    `signal: "stop"` cancels the current engine run.
  - Planning completion posts a `# Implementation Plan` issue comment, moves
    the issue to `Ready`, and waits. The next reply starts implementation, as
    does a later move to `In Progress`.
  - `dismissed` / `ended` removes the managed worktree, when one exists, and
    the session file.
- `Issue` action `update`: a state change to `In Progress` auto-starts only for
  an existing Linear session with an engine session and an issue comment whose
  body contains `# Implementation Plan` or `## Implementation Plan`.
- When a run returns `IMPLEMENTATION_COMPLETE`, Open Session runs `gh pr create`
  and posts the resulting PR URL to the Linear agent session. The implementation
  prompt asks the agent for a short Linear summary, then a
  `===OPENSESSION-PR-BODY===` line, then the full reviewer-facing PR
  description. The wrapper uses that description as the PR body, adds the
  ticket link, requester metadata, and the session-attribution footer, and
  refuses to publish a body or title that contains a configured private term on
  a public repository. A later implementation turn replaces only the managed
  agent-description section, so human edits elsewhere in the description
  survive. An open PR for the checkout's current branch is reused, and the URL
  is stored in the session file, so a retried implementation does not open a
  second PR. A failure is reported in Linear with a short reason (the raw
  command output stays in the server log). A reviewer request that GitHub
  rejects does not hide a created PR. Failed PR creation is not retried
  automatically.

Other event types and actions are acknowledged and ignored. Team IDs are
fetched from each issue; only the workflow status names above are fixed.

## Repository and persistence behavior

For a non-shared default repo, worktrees live at
`<paths.worktreesDir>/<wtPrefix>-<branch>`. `paths.worktreesDir` defaults to
`~/.opensession/worktrees` and can be overridden by
`OPENSESSION_WORKTREES_DIR`. The branch is Linear's suggested branch name for
the issue (`Issue.branchName`), which follows the branch format configured for
the issue's team in Linear. Open Session uses it verbatim, so a PR opened from
the checkout matches Linear's normal branch-based issue linking. If Linear
returns no usable name, the agent falls back to the first two words of the
issue title plus its issue identifier. Reassigning an issue regenerates that
branch; when the previous branch still exists it gets a `-2`, `-3`, … suffix so
the new agent session starts in its own worktree. Slashes in the configured
format are preserved in the git ref, while the on-disk checkout directory
replaces them with `~` so it stays one level under `paths.worktreesDir`.

Session metadata is stored under `~/.linear-sessions/`. Current files are named
after the Linear agent-session id, with the generated branch recorded inside the
file; files written before that change remain named after the branch. This keeps
two agent sessions on the same issue (same generated branch) separate: their
Open Session ids, transcripts, worktrees and external links are distinct. Ending
a session records a terminal marker under `~/.linear-sessions/.ended/` before
removing its file, so a webhook replay after a restart cannot start a new run
for the ended id. New sessions are filed into a workspace before the greeting
is posted, using the repository, branch and checkout that were actually created
and the issue creator's mapped attribution. The greeting and each incoming
direction reply are also written to the OpenSession transcript with stable ids;
a replayed webhook updates those rows instead of duplicating them. On startup,
Open Session restores files updated within the last seven days when they have a
Linear session ID and either an engine session ID or the `awaiting_direction`
phase. Older files remain on disk but are not
restored. An interrupted background turn is not restarted automatically; a
later prompt can continue the restored session.

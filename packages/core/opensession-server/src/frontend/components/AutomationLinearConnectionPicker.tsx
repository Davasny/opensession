import { useEffect, useState } from "react";
import {
  fetchAutomationLinearConnections,
  linearConnectionKey,
  linearConnectionLabel,
  type AutomationLinearConnection,
  type AutomationLinearConnectionOption,
} from "../lib/automation-linear-connection";
import { BASE_PATH } from "../lib/base";
import { errorMessage } from "../lib/error-message";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { InlineAlert } from "../ui/state";

export function AutomationLinearConnectionPicker({
  value,
  onChange,
}: {
  value: AutomationLinearConnection | null;
  onChange: (connection: AutomationLinearConnection | null) => void;
}) {
  const [connections, setConnections] = useState<
    AutomationLinearConnectionOption[]
  >([]);
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string }
  >({ kind: "loading" });
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let ignore = false;
    fetchAutomationLinearConnections().then(
      (next) => {
        if (ignore) return;
        setConnections(next);
        setState({ kind: "ready" });
      },
      (cause: unknown) => {
        if (ignore) return;
        setState({
          kind: "error",
          message: errorMessage(cause, "Could not load Linear connections"),
        });
      },
    );
    return () => {
      ignore = true;
    };
  }, [request]);

  const selectedKey = value ? linearConnectionKey(value) : "";
  const missing =
    value &&
    state.kind === "ready" &&
    !connections.some(
      (connection) => linearConnectionKey(connection) === selectedKey,
    );
  const options = [
    { value: "", label: "No app connection" },
    ...connections.map((connection) => ({
      value: linearConnectionKey(connection),
      label: linearConnectionLabel(connection),
    })),
    ...(value &&
    !connections.some(
      (connection) => linearConnectionKey(connection) === selectedKey,
    )
      ? [
          {
            value: selectedKey,
            label: `${value.appId} · ${value.organizationId}${missing ? " · unavailable" : ""}`,
          },
        ]
      : []),
  ];

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-label font-medium text-fg">
          Linear connection
        </span>
        <a
          className="ml-auto text-label text-dim underline phone:inline-flex phone:min-h-11 phone:items-center"
          href={`${BASE_PATH}/settings/integrations`}
        >
          Manage Linear apps
        </a>
      </div>
      <Select.Root
        value={selectedKey}
        items={options}
        disabled={state.kind === "loading"}
        onValueChange={(key) => {
          if (key === null) return;
          if (!key) onChange(null);
          else {
            const connection = connections.find(
              (item) => linearConnectionKey(item) === key,
            );
            if (connection)
              onChange({
                appId: connection.appId,
                organizationId: connection.organizationId,
              });
          }
        }}
      >
        <Select.Trigger
          aria-label="Linear connection"
          className="w-full phone:min-h-11"
        />
        <Select.Popup className="w-[var(--anchor-width)] max-w-[calc(100vw-1rem)]">
          {options.map((option) => (
            <Select.Item
              key={option.value}
              value={option.value}
              className="phone:min-h-11"
            >
              <span className="whitespace-normal [overflow-wrap:anywhere]">
                {option.label}
              </span>
            </Select.Item>
          ))}
        </Select.Popup>
      </Select.Root>
      {state.kind === "loading" ? (
        <span role="status" className="text-supporting text-faint">
          Loading Linear connections
        </span>
      ) : state.kind === "error" ? (
        <InlineAlert>
          <div className="flex flex-wrap items-center gap-2">
            <span>{state.message}</span>
            <Button
              size="sm"
              variant="soft"
              className="phone:min-h-11"
              onClick={() => {
                setState({ kind: "loading" });
                setRequest((current) => current + 1);
              }}
            >
              Try again
            </Button>
          </div>
        </InlineAlert>
      ) : missing ? (
        <InlineAlert>
          This Linear connection is unavailable. Reconnect the app or choose
          another connection. Runs will not use another account.
        </InlineAlert>
      ) : connections.length === 0 ? (
        <span className="text-supporting text-faint">
          Connect a Linear app in Settings to use it here. No separate MCP setup
          needed.
        </span>
      ) : (
        <span className="text-supporting text-faint">
          {value
            ? "Runs use this app's Linear tools and sign-in, not a personal account."
            : "Choose an app to give this automation Linear tools. No separate MCP setup needed."}
        </span>
      )}
    </div>
  );
}

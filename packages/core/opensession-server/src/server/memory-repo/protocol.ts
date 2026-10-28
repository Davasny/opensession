/** Messages between the memory-repo client and memory-repo-worker.ts. */

import type { MemoryRepoServiceOptions } from "./service";

export type MemoryRepoWorkerRequest =
  | { t: "open"; options: MemoryRepoServiceOptions }
  | {
      t: "call";
      id: number;
      /** "service.<method>" or "index.<method>". */
      target: "service" | "index";
      method: string;
      args: unknown[];
    };

export type MemoryRepoWorkerResponse =
  | { t: "ok"; id: number; value: unknown }
  | { t: "error"; id: number; name: string; message: string; status?: number };

/** Service methods the gateway may call. Anything else is refused. */
export const SERVICE_METHODS = [
  "ensureRepo",
  "listRepos",
  "repoExists",
  "head",
  "refresh",
  "fresh",
  "freshAll",
  "installHooks",
  "addEntry",
  "updateEntry",
  "removeEntries",
  "restoreEntry",
  "mergeEntries",
  "history",
  "diff",
  "revert",
  "readFile",
  "remoteUrl",
  "remoteStatus",
  "setRemote",
  "syncRemote",
  "syncAllRemotes",
  "exportFromV2",
  "bareDir",
  "ensureCheckouts",
  "entryPoints",
  "listFiles",
  "writeFile",
  "migrateFromV2",
  "parityReport",
  "rollbackIntoV2",
  "reinstallHooks",
] as const;

/** Index (MemoryStore) methods the gateway may call. */
export const INDEX_METHODS = [
  "get",
  "list",
  "search",
  "retrieve",
  "all",
  "stats",
  "markRetrieved",
  "expireDue",
  "findRelatedCandidates",
  "delete",
  "metadata",
  "setMetadata",
] as const;

export type ServiceMethod = (typeof SERVICE_METHODS)[number];
export type IndexMethod = (typeof INDEX_METHODS)[number];

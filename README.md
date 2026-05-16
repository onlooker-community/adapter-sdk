# @onlooker-community/adapter-sdk

Foundational SDK for Onlooker **runtime adapters**. Defines the contract every adapter implements, the abstract base class that handles the cross-runtime concerns, and the canonical event writer.

An adapter sits between a runtime (Claude Code, Cursor, Copilot, ...) and the canonical Onlooker event bus. It does two things:

1. **Translate** runtime-native events into canonical [`OnlookerEvent`](https://github.com/onlooker-community/schema) envelopes.
2. **Deliver** plugin decisions back to the runtime in its native format (block / allow / inject context).

## Install

```sh
npm install @onlooker-community/adapter-sdk
```

This package declares `@onlooker-community/schema` as a peer dependency. Install it explicitly:

```sh
npm install @onlooker-community/schema
```

## The contract

```ts
import type { OnlookerRuntimeAdapter } from "@onlooker-community/adapter-sdk";
```

Every adapter declares:

- `runtimeId` — one of the canonical strings from `schema.event.v1.json` (`claude-code`, `cursor`, `copilot`, `gemini`, `custom`).
- `version` — the adapter's own semver string.

…and implements two clusters of methods:

**Event ingestion (runtime → canonical events):**

- `onSessionStart`, `onSessionEnd`
- `onFileWrite`, `onFileEdit`
- `onShellExec`, `onWebFetch`
- `onAgentSpawn`, `onAgentComplete`

Each receives the runtime-native payload as `unknown`, normalises it, and returns an `OnlookerEvent`.

**Decision delivery (plugin decisions → runtime):**

- `blockOperation(reason)`
- `allowOperation()`
- `injectContext(content)`

These are best-effort by contract — adapters must never throw out of them.

## Building one — extend `BaseAdapter`

```ts
import { BaseAdapter } from "@onlooker-community/adapter-sdk";
import type { OnlookerEvent } from "@onlooker-community/schema";

export class ClaudeCodeAdapter extends BaseAdapter {
  constructor(machineId: string) {
    super({ runtimeId: "claude-code", version: "0.1.0", machineId });
  }

  onSessionStart(raw: unknown): OnlookerEvent {
    const sid = (raw as { session_id: string }).session_id;
    this.startSession(sid);
    return this.writeEvent({
      plugin: "claude-code",
      event_type: "session.start",
      payload: {
        cwd: process.cwd(),
        project_name: null,
        git_branch: null,
        git_commit: null,
      },
      session_id: sid,
    });
  }

  // ... rest of the on* + decision-delivery methods
}
```

`BaseAdapter` handles:

- **Session ID generation and tracking** — `newSessionId()` mints UUIDs; `startSession(sid)` initialises a per-session sequence counter.
- **Sequence counter per session** — each call to `buildEvent` / `writeEvent` reads-then-increments the counter for `session_id` so events within a session carry monotonic sequence numbers.
- **`createEventBase()` equivalent** — the shared envelope fields (`id`, `schema_version`, `runtime`, `machine_id`, `timestamp`, `session_id`, `sequence`) come from `buildEvent`.
- **`writeEvent(event)`** — appends to `~/.onlooker/<runtimeId>/<plugin>/<session_id>.jsonl`.

## Canonical event layout

Events land at:

```text
~/.onlooker/<runtimeId>/<plugin>/<session_id>.jsonl
```

…one JSON line per event, matching the [canonical envelope](https://github.com/onlooker-community/schema/blob/main/schemas/event.v1.json).

Tests and alternate installs can override the root by passing `eventWriterOptions: { rootDir }` to the `BaseAdapter` constructor.

## Test helpers

`EventWriter` and `eventLogPath` are exported for adapters that want to bypass `BaseAdapter` (e.g. integration tests, runtime probes):

```ts
import { EventWriter, eventLogPath } from "@onlooker-community/adapter-sdk";

const writer = new EventWriter({ rootDir: "/tmp/onl-test" });
writer.write(event);
console.log(writer.pathFor(event));
```

## Local development

After cloning, `npm install` runs `simple-git-hooks` via `prepare` and
installs a `pre-push` hook that mirrors CI:

```sh
npm run verify    # biome ci → typecheck → test → build
```

The same four commands run in GitHub Actions, so a green `verify` is a
green PR. To skip the hook in an emergency, `SKIP_SIMPLE_GIT_HOOKS=1 git push`.

To auto-fix Biome lint, format, and import-sort findings in one go:

```sh
npm run fix       # biome check --write
```

## License

Apache-2.0

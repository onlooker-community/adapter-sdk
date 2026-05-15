// EventWriter — appends canonical events to per-session JSONL files.
//
// File layout, by contract:
//   ~/.onlooker/<runtimeId>/<plugin>/<session_id>.jsonl
//
// Each event becomes a single JSON line. Writes are append-only and
// best-effort: if the filesystem is unavailable, the writer logs to
// stderr and continues so the runtime doesn't crash on disk pressure.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OnlookerEvent } from "@onlooker-community/schema";

export interface EventWriterOptions {
	/**
	 * Root directory for canonical event JSONL. Defaults to
	 * `~/.onlooker`. Override for tests or alternate installs.
	 */
	rootDir?: string;
}

/**
 * Resolve the canonical JSONL path for a single event.
 *
 * `rootDir` defaults to `~/.onlooker` — callers passing a custom root
 * (typically tests) get full control.
 */
export function eventLogPath(
	event: OnlookerEvent,
	rootDir: string = join(homedir(), ".onlooker"),
): string {
	return join(rootDir, event.runtime, event.plugin, `${event.session_id}.jsonl`);
}

/**
 * Append a single canonical event to its per-session JSONL file. Side
 * effect only — returns nothing. Errors are swallowed and reported via
 * `onError` (default: stderr) so adapters can stay non-blocking.
 */
export class EventWriter {
	private readonly rootDir: string;
	private readonly onError: (err: unknown, event: OnlookerEvent) => void;

	constructor(
		options: EventWriterOptions = {},
		onError: (err: unknown, event: OnlookerEvent) => void = (err, event) => {
			// One-line stderr is enough to be greppable; full event would
			// be noisy and may contain large payloads.
			console.error(
				`[adapter-sdk] event write failed for ${event.event_type} ` +
					`session=${event.session_id}: ${(err as Error).message}`,
			);
		},
	) {
		this.rootDir = options.rootDir ?? join(homedir(), ".onlooker");
		this.onError = onError;
	}

	write(event: OnlookerEvent): void {
		const path = eventLogPath(event, this.rootDir);
		try {
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${JSON.stringify(event)}\n`);
		} catch (err) {
			this.onError(err, event);
		}
	}

	/**
	 * Path the next write for this event would land at. Useful for tests
	 * and for adapters that want to surface the log location to users.
	 */
	pathFor(event: OnlookerEvent): string {
		return eventLogPath(event, this.rootDir);
	}
}

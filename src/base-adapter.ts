// BaseAdapter — abstract base class every runtime adapter extends.
//
// Owns the cross-runtime concerns so concrete adapters can focus on the
// runtime-specific translation:
//   * session id tracking with one monotonic sequence counter per
//     session
//   * createEventBase() — shared envelope fields (id, schema_version,
//     timestamp, sequence, etc.)
//   * writeEvent() — append to ~/.onlooker/<runtimeId>/<plugin>/<sid>.jsonl
//
// Subclasses implement the `on*` callbacks and the decision-delivery
// methods. Subclasses MUST call `this.startSession(sessionId)` from
// their session-start handler so the sequence counter is initialised
// before any other event for that session is created.

import { randomUUID } from "node:crypto";
import type {
	CreateEventParams,
	EventType,
	OnlookerEvent,
	PayloadFor,
	RuntimeId,
} from "@onlooker-community/schema";
import { createEvent } from "@onlooker-community/schema";
import { EventWriter, type EventWriterOptions } from "./event-writer.js";
import type { OnlookerRuntimeAdapter } from "./types.js";

export interface BaseAdapterOptions {
	/**
	 * Optional override for the event writer. Tests pass a writer
	 * configured against a temp dir; production code leaves this off
	 * and gets the default ~/.onlooker writer.
	 */
	eventWriter?: EventWriter;
	/**
	 * Equivalent to passing `new EventWriter({ rootDir })`. Kept as a
	 * convenience so adapters don't have to import EventWriter just to
	 * change the root.
	 */
	eventWriterOptions?: EventWriterOptions;
}

/**
 * Shape the subclass passes to `buildEvent` when creating a canonical
 * event. The base class fills in everything else (id, schema_version,
 * runtime, machine_id, timestamp, session_id, sequence).
 */
export interface BuildEventParams<T extends EventType> {
	plugin: string;
	event_type: T;
	payload: PayloadFor<T>;
	session_id: string;
	adapter_id?: string;
	cost_usd?: number;
	token_count?: number;
}

/**
 * Abstract base every OnlookerRuntimeAdapter extends.
 *
 * Subclasses must:
 *   1. Pass `runtimeId`, `version`, and `machineId` to `super()`.
 *   2. Call `this.startSession(sessionId)` from `onSessionStart` (and
 *      whenever they otherwise observe a session begin) so the
 *      sequence counter exists.
 *   3. Implement the abstract `on*` callbacks and the
 *      RuntimeDecisionDelivery methods.
 *   4. Use `this.buildEvent()` to construct events — that's what
 *      keeps id/schema_version/sequence consistent.
 */
export abstract class BaseAdapter implements OnlookerRuntimeAdapter {
	public readonly runtimeId: RuntimeId;
	public readonly version: string;

	/** Stable machine identifier (UUID). One per host install. */
	protected readonly machineId: string;

	/**
	 * Per-session sequence counters. Each `createEvent` call inside
	 * `buildEvent` reads-then-increments the counter for that session
	 * id so events within a session carry monotonic sequence numbers.
	 */
	private readonly sequence: Map<string, number> = new Map();

	private readonly writer: EventWriter;

	constructor(args: {
		runtimeId: RuntimeId;
		version: string;
		machineId: string;
		options?: BaseAdapterOptions;
	}) {
		this.runtimeId = args.runtimeId;
		this.version = args.version;
		this.machineId = args.machineId;
		this.writer =
			args.options?.eventWriter ??
			new EventWriter(args.options?.eventWriterOptions ?? {});
	}

	// ── Session tracking ────────────────────────────────────────────────────

	/**
	 * Initialise (or reset) the sequence counter for `sessionId`.
	 * Called from `onSessionStart`. Idempotent — calling twice resets
	 * the counter, which is the desired behavior for resumed sessions
	 * that issue a fresh session-start event.
	 */
	protected startSession(sessionId: string): void {
		this.sequence.set(sessionId, 0);
	}

	/**
	 * Generate a new session id. Adapters can pull this if the runtime
	 * doesn't surface one of its own (e.g. a stateless tool invocation).
	 */
	protected newSessionId(): string {
		return randomUUID();
	}

	/**
	 * Read-and-increment the sequence counter for `sessionId`. Lazily
	 * initialises if the session wasn't seen before — adapters
	 * occasionally receive events out of order (session-end fires
	 * before session-start due to clock skew), and we'd rather emit
	 * those with sequence=0 than crash.
	 */
	protected nextSequence(sessionId: string): number {
		const current = this.sequence.get(sessionId) ?? 0;
		this.sequence.set(sessionId, current + 1);
		return current;
	}

	// ── Event construction ──────────────────────────────────────────────────

	/**
	 * Shared envelope fields. Concrete `on*` callbacks call this to
	 * build the canonical event, then pass the result to `writeEvent`
	 * (or yield it from the callback for the caller to write).
	 */
	protected buildEvent<T extends EventType>(
		params: BuildEventParams<T>,
	): OnlookerEvent<T> {
		const base: CreateEventParams<T> = {
			runtime: this.runtimeId,
			plugin: params.plugin,
			machine_id: this.machineId,
			session_id: params.session_id,
			event_type: params.event_type,
			payload: params.payload,
		};
		if (params.adapter_id !== undefined) base.adapter_id = params.adapter_id;
		if (params.cost_usd !== undefined) base.cost_usd = params.cost_usd;
		if (params.token_count !== undefined) base.token_count = params.token_count;

		const event = createEvent<T>(base);
		// `createEvent` uses a module-scoped global counter; we override
		// with our per-session counter so adapters running in long-lived
		// processes (Claude Code daemon) keep per-session sequences
		// instead of one monotonic counter for everything.
		event.sequence = this.nextSequence(params.session_id);
		return event;
	}

	/**
	 * Convenience: build + persist. Concrete adapters typically end
	 * their `on*` callbacks with this — `return this.writeEvent(...)`.
	 */
	protected writeEvent<T extends EventType>(
		params: BuildEventParams<T>,
	): OnlookerEvent<T> {
		const event = this.buildEvent<T>(params);
		this.writer.write(event);
		return event;
	}

	/** Test/inspection helper — exposes the resolved JSONL path. */
	public pathFor(event: OnlookerEvent): string {
		return this.writer.pathFor(event);
	}

	// ── Abstract surface (subclasses fill these in) ─────────────────────────

	abstract onSessionStart(rawEvent: unknown): OnlookerEvent;
	abstract onSessionEnd(rawEvent: unknown): OnlookerEvent;
	abstract onFileWrite(rawEvent: unknown): OnlookerEvent;
	abstract onFileEdit(rawEvent: unknown): OnlookerEvent;
	abstract onShellExec(rawEvent: unknown): OnlookerEvent;
	abstract onWebFetch(rawEvent: unknown): OnlookerEvent;
	abstract onAgentSpawn(rawEvent: unknown): OnlookerEvent;
	abstract onAgentComplete(rawEvent: unknown): OnlookerEvent;

	abstract blockOperation(reason: string): void;
	abstract allowOperation(): void;
	abstract injectContext(content: string): void;
}

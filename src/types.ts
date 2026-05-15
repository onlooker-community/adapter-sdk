// Public types for the Onlooker adapter SDK.
//
// `OnlookerRuntimeAdapter` is the contract every runtime adapter implements.
// Adapters translate runtime-native events (Claude Code hook payloads,
// Cursor tool calls, GitHub Copilot completions, etc.) into canonical
// OnlookerEvent envelopes from @onlooker-community/schema, and deliver
// plugin decisions back to the runtime in its native format.

import type { OnlookerEvent, RuntimeId } from "@onlooker-community/schema";

/**
 * Mapping from canonical lifecycle event types to the OnlookerEvent
 * payload shape the schema expects for each. Adapter callbacks are
 * typed against this map so a future schema change surfaces as a type
 * error in adapters before it surfaces in production.
 */
export type AdapterEventCallbacks = {
	onSessionStart: (rawEvent: unknown) => OnlookerEvent;
	onSessionEnd: (rawEvent: unknown) => OnlookerEvent;
	onFileWrite: (rawEvent: unknown) => OnlookerEvent;
	onFileEdit: (rawEvent: unknown) => OnlookerEvent;
	onShellExec: (rawEvent: unknown) => OnlookerEvent;
	onWebFetch: (rawEvent: unknown) => OnlookerEvent;
	onAgentSpawn: (rawEvent: unknown) => OnlookerEvent;
	onAgentComplete: (rawEvent: unknown) => OnlookerEvent;
};

/**
 * Plugin → runtime decision delivery. The plugin layer calls these to
 * tell the runtime adapter how to act on a tool invocation. Adapters
 * are free to translate the call to whatever native primitive the
 * runtime exposes (Claude Code hook stdout, MCP response, IDE notify,
 * etc.). All three are best-effort by contract — adapters must never
 * throw out of these methods.
 */
export interface RuntimeDecisionDelivery {
	/** Block the in-flight operation. `reason` is shown to the user. */
	blockOperation(reason: string): void;
	/** Allow the in-flight operation to proceed unchanged. */
	allowOperation(): void;
	/**
	 * Inject context into the runtime's prompt / conversation surface.
	 * The exact mechanism depends on the runtime: Claude Code uses
	 * SessionStart `additionalContext`, Cursor a system message, etc.
	 */
	injectContext(content: string): void;
}

/**
 * The OnlookerRuntimeAdapter contract.
 *
 * Implementations sit between a runtime (Claude Code, Cursor, ...) and
 * the canonical event bus. They:
 *   - normalise runtime-native events into OnlookerEvent envelopes via
 *     the `on*` callbacks
 *   - deliver plugin decisions back to the runtime via the
 *     RuntimeDecisionDelivery methods
 *
 * Every adapter declares its `runtimeId` (one of the canonical strings
 * in the schema enum) and a semantic `version` so consumers can pin or
 * gate by adapter capability.
 */
export interface OnlookerRuntimeAdapter
	extends AdapterEventCallbacks,
		RuntimeDecisionDelivery {
	readonly runtimeId: RuntimeId;
	readonly version: string;
}

/** Re-export RuntimeId so adapters don't have to import from schema. */
export type { OnlookerEvent, RuntimeId };

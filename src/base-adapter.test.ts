// Unit tests for BaseAdapter + EventWriter.
//
// Uses a temp dir per test so the canonical JSONL writer can be
// exercised end-to-end without touching the real `~/.onlooker` tree.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BaseAdapter, EventWriter, eventLogPath } from "./index.js";
import type { OnlookerEvent } from "@onlooker-community/schema";

// ── Test double ──────────────────────────────────────────────────────────

/** Minimal concrete adapter that exercises BaseAdapter's machinery. */
class TestAdapter extends BaseAdapter {
	public delivery: Array<{ kind: string; payload: string }> = [];

	override onSessionStart(rawEvent: unknown): OnlookerEvent {
		const sid = (rawEvent as { session_id: string }).session_id;
		this.startSession(sid);
		return this.writeEvent({
			plugin: "test",
			event_type: "session.start",
			payload: { working_directory: "/tmp" },
			session_id: sid,
		});
	}

	override onSessionEnd(rawEvent: unknown): OnlookerEvent {
		const sid = (rawEvent as { session_id: string }).session_id;
		return this.writeEvent({
			plugin: "test",
			event_type: "session.end",
			payload: { duration_ms: 1000, turn_count: 1, end_reason: "user_exit" },
			session_id: sid,
		});
	}

	override onFileWrite(rawEvent: unknown): OnlookerEvent {
		const { session_id, path } = rawEvent as {
			session_id: string;
			path: string;
		};
		return this.writeEvent({
			plugin: "test",
			event_type: "tool.file.write",
			payload: { path, operation: "create" },
			session_id,
		});
	}

	override onFileEdit(rawEvent: unknown): OnlookerEvent {
		const { session_id, path } = rawEvent as {
			session_id: string;
			path: string;
		};
		return this.writeEvent({
			plugin: "test",
			event_type: "tool.file.edit",
			payload: { path },
			session_id,
		});
	}

	override onShellExec(rawEvent: unknown): OnlookerEvent {
		const { session_id, command } = rawEvent as {
			session_id: string;
			command: string;
		};
		return this.writeEvent({
			plugin: "test",
			event_type: "tool.shell.exec",
			payload: { command, exit_code: 0 },
			session_id,
		});
	}

	override onWebFetch(rawEvent: unknown): OnlookerEvent {
		const { session_id, url } = rawEvent as {
			session_id: string;
			url: string;
		};
		return this.writeEvent({
			plugin: "test",
			event_type: "tool.web.fetch",
			payload: { url, status_code: 200 },
			session_id,
		});
	}

	override onAgentSpawn(rawEvent: unknown): OnlookerEvent {
		const { session_id, agent_id } = rawEvent as {
			session_id: string;
			agent_id: string;
		};
		return this.writeEvent({
			plugin: "test",
			event_type: "tool.agent.spawn",
			payload: { subagent_id: agent_id },
			session_id,
		});
	}

	override onAgentComplete(rawEvent: unknown): OnlookerEvent {
		const { session_id, agent_id } = rawEvent as {
			session_id: string;
			agent_id: string;
		};
		return this.writeEvent({
			plugin: "test",
			event_type: "tool.agent.complete",
			payload: { subagent_id: agent_id, success: true, duration_ms: 10 },
			session_id,
		});
	}

	override blockOperation(reason: string): void {
		this.delivery.push({ kind: "block", payload: reason });
	}
	override allowOperation(): void {
		this.delivery.push({ kind: "allow", payload: "" });
	}
	override injectContext(content: string): void {
		this.delivery.push({ kind: "inject", payload: content });
	}
}

// ── Fixtures ─────────────────────────────────────────────────────────────

let tmpRoot: string;
let adapter: TestAdapter;
let sessionId: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "adapter-sdk-"));
	adapter = new TestAdapter({
		runtimeId: "claude-code",
		version: "0.1.0",
		machineId: randomUUID(),
		options: { eventWriterOptions: { rootDir: tmpRoot } },
	});
	sessionId = randomUUID();
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("BaseAdapter", () => {
	it("exposes the configured runtimeId and version", () => {
		expect(adapter.runtimeId).toBe("claude-code");
		expect(adapter.version).toBe("0.1.0");
	});

	it("writes session-start to ~/<runtime>/<plugin>/<sid>.jsonl", () => {
		const event = adapter.onSessionStart({ session_id: sessionId });
		const expectedPath = join(
			tmpRoot,
			"claude-code",
			"test",
			`${sessionId}.jsonl`,
		);
		expect(adapter.pathFor(event)).toBe(expectedPath);
		const content = readFileSync(expectedPath, "utf8").trim();
		const written = JSON.parse(content) as OnlookerEvent;
		expect(written.id).toBe(event.id);
		expect(written.event_type).toBe("session.start");
		expect(written.session_id).toBe(sessionId);
		expect(written.runtime).toBe("claude-code");
		expect(written.schema_version).toBe("1.0");
	});

	it("assigns monotonic sequence numbers within a session", () => {
		adapter.onSessionStart({ session_id: sessionId });
		const a = adapter.onFileWrite({ session_id: sessionId, path: "/a.ts" });
		const b = adapter.onFileWrite({ session_id: sessionId, path: "/b.ts" });
		const c = adapter.onSessionEnd({ session_id: sessionId });
		// session.start consumed seq=0; subsequent events tick from 1.
		expect(a.sequence).toBe(1);
		expect(b.sequence).toBe(2);
		expect(c.sequence).toBe(3);
	});

	it("isolates sequence counters per session", () => {
		const sid2 = randomUUID();
		adapter.onSessionStart({ session_id: sessionId });
		adapter.onSessionStart({ session_id: sid2 });
		const a = adapter.onFileWrite({ session_id: sessionId, path: "/a.ts" });
		const b = adapter.onFileWrite({ session_id: sid2, path: "/b.ts" });
		// Each session ticks from 1 because session.start consumed its own 0.
		expect(a.sequence).toBe(1);
		expect(b.sequence).toBe(1);
	});

	it("resets the counter when startSession is called again (resume case)", () => {
		adapter.onSessionStart({ session_id: sessionId });
		adapter.onFileWrite({ session_id: sessionId, path: "/a.ts" });
		// Fresh session-start for the same id (e.g. agent restart) should
		// reset the counter so downstream consumers can detect it.
		const restart = adapter.onSessionStart({ session_id: sessionId });
		expect(restart.sequence).toBe(0);
	});

	it("appends multiple events to the same JSONL file", () => {
		adapter.onSessionStart({ session_id: sessionId });
		adapter.onFileWrite({ session_id: sessionId, path: "/a.ts" });
		adapter.onFileEdit({ session_id: sessionId, path: "/b.ts" });
		adapter.onSessionEnd({ session_id: sessionId });

		const path = join(tmpRoot, "claude-code", "test", `${sessionId}.jsonl`);
		const lines = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.filter((l) => l.length > 0);
		expect(lines).toHaveLength(4);
		const types = lines.map((l) => (JSON.parse(l) as OnlookerEvent).event_type);
		expect(types).toEqual([
			"session.start",
			"tool.file.write",
			"tool.file.edit",
			"session.end",
		]);
	});

	it("delivers block/allow/inject decisions to the runtime", () => {
		adapter.blockOperation("rm -rf /");
		adapter.allowOperation();
		adapter.injectContext("Continuing from last session…");
		expect(adapter.delivery).toEqual([
			{ kind: "block", payload: "rm -rf /" },
			{ kind: "allow", payload: "" },
			{ kind: "inject", payload: "Continuing from last session…" },
		]);
	});

	it("populates the canonical envelope (id, schema_version, machine_id, timestamp)", () => {
		const event = adapter.onSessionStart({ session_id: sessionId });
		expect(event.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(event.schema_version).toBe("1.0");
		expect(event.machine_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
});

describe("EventWriter", () => {
	it("eventLogPath builds <root>/<runtime>/<plugin>/<sid>.jsonl", () => {
		const event: OnlookerEvent = {
			id: "00000000-0000-0000-0000-000000000000",
			schema_version: "1.0",
			runtime: "cursor",
			plugin: "warden",
			machine_id: "00000000-0000-0000-0000-000000000000",
			timestamp: new Date().toISOString(),
			session_id: "sess-x",
			sequence: 0,
			event_type: "session.start",
			payload: { working_directory: "/x" },
		};
		expect(eventLogPath(event, "/tmp/onl")).toBe(
			"/tmp/onl/cursor/warden/sess-x.jsonl",
		);
	});

	it("swallows write errors via onError callback", () => {
		const errors: Array<{ message: string }> = [];
		const writer = new EventWriter(
			// Point at a path that already exists as a file so mkdir of
			// the same name fails — triggers the onError branch without
			// needing fs mocking.
			{ rootDir: "/dev/null/cant-mkdir-here" },
			(err) => errors.push({ message: (err as Error).message }),
		);
		const event: OnlookerEvent = {
			id: "00000000-0000-0000-0000-000000000000",
			schema_version: "1.0",
			runtime: "claude-code",
			plugin: "test",
			machine_id: "00000000-0000-0000-0000-000000000000",
			timestamp: new Date().toISOString(),
			session_id: "sess-err",
			sequence: 0,
			event_type: "session.start",
			payload: { working_directory: "/x" },
		};
		// Should not throw.
		writer.write(event);
		expect(errors.length).toBe(1);
		expect(errors[0]?.message).toBeTruthy();
	});
});

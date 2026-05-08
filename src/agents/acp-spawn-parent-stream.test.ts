import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";
import { listAcpParentStreamEvents } from "./acp-parent-stream-store.sqlite.js";

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatMock = vi.fn();
const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
let tempStateDir: string | null = null;

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../infra/heartbeat-wake.js", async () => {
  return await mergeMockedModule(
    await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
      "../infra/heartbeat-wake.js",
    ),
    () => ({
      requestHeartbeat: (...args: unknown[]) => requestHeartbeatMock(...args),
    }),
  );
});

let emitAgentEvent: typeof import("../infra/agent-events.js").emitAgentEvent;
let startAcpSpawnParentStreamRelay: typeof import("./acp-spawn-parent-stream.js").startAcpSpawnParentStreamRelay;

function collectedTexts() {
  return enqueueSystemEventMock.mock.calls.map((call) => String(call[0] ?? ""));
}

describe("startAcpSpawnParentStreamRelay", () => {
  beforeAll(async () => {
    ({ emitAgentEvent } = await import("../infra/agent-events.js"));
    ({ startAcpSpawnParentStreamRelay } = await import("./acp-spawn-parent-stream.js"));
  });

  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-parent-stream-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    enqueueSystemEventMock.mockClear();
    requestHeartbeatMock.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T01:00:00.000Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
  });

  it("relays assistant progress and completion to the parent session", () => {
    const deliveryContext = {
      channel: "forum",
      to: "-1001234567890",
      accountId: "default",
      threadId: 1122,
    };
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-1",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-1",
      agentId: "codex",
      deliveryContext,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-1",
      stream: "assistant",
      data: {
        delta: "hello from child",
      },
    });
    vi.advanceTimersByTime(15);

    emitAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 1_000,
        endedAt: 3_100,
      },
    });

    const texts = collectedTexts();
    expect(texts).toEqual(
      expect.arrayContaining([expect.stringContaining("Started codex session")]),
    );
    expect(texts).toEqual(
      expect.arrayContaining([expect.stringContaining("codex: hello from child")]),
    );
    expect(texts).toEqual(
      expect.arrayContaining([expect.stringContaining("codex run completed in 2s")]),
    );
    expect(
      enqueueSystemEventMock.mock.calls.every(
        (call) => (call[1] as { trusted?: boolean } | undefined)?.trusted === false,
      ),
    ).toBe(true);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sessionKey: "agent:main:main",
        deliveryContext,
        trusted: false,
      }),
    );
    expect(requestHeartbeatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "acp:spawn:stream",
        sessionKey: "agent:main:main",
      }),
    );
    relay.dispose();
    const events = listAcpParentStreamEvents({ agentId: "codex", runId: "run-1" });
    expect(events.map((event) => event.event.kind)).toEqual([
      "system_event",
      "assistant_delta",
      "system_event",
      "lifecycle",
      "system_event",
    ]);
  });

  it("emits a no-output notice and a resumed notice when output returns", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-2",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-2",
      agentId: "codex",
      streamFlushMs: 1,
      noOutputNoticeMs: 1_000,
      noOutputPollMs: 250,
    });

    vi.advanceTimersByTime(1_500);
    expect(collectedTexts()).toEqual(
      expect.arrayContaining([expect.stringContaining("has produced no output for 1s")]),
    );

    emitAgentEvent({
      runId: "run-2",
      stream: "assistant",
      data: {
        delta: "resumed output",
      },
    });
    vi.advanceTimersByTime(5);

    const texts = collectedTexts();
    expect(texts).toEqual(expect.arrayContaining([expect.stringContaining("resumed output.")]));
    expect(texts).toEqual(
      expect.arrayContaining([expect.stringContaining("codex: resumed output")]),
    );

    emitAgentEvent({
      runId: "run-2",
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "boom",
      },
    });
    expect(collectedTexts()).toEqual(
      expect.arrayContaining([expect.stringContaining("run failed: boom")]),
    );
    relay.dispose();
  });

  it("auto-disposes stale relays after max lifetime timeout", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-3",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-3",
      agentId: "codex",
      streamFlushMs: 1,
      noOutputNoticeMs: 0,
      maxRelayLifetimeMs: 1_000,
    });

    vi.advanceTimersByTime(1_001);
    expect(collectedTexts()).toEqual(
      expect.arrayContaining([expect.stringContaining("stream relay timed out after 1s")]),
    );

    const before = enqueueSystemEventMock.mock.calls.length;
    emitAgentEvent({
      runId: "run-3",
      stream: "assistant",
      data: {
        delta: "late output",
      },
    });
    vi.advanceTimersByTime(5);

    expect(enqueueSystemEventMock.mock.calls).toHaveLength(before);
    relay.dispose();
  });

  it("supports delayed start notices", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-4",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-4",
      agentId: "codex",
      emitStartNotice: false,
    });

    expect(collectedTexts()).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Started codex session")]),
    );

    relay.notifyStarted();

    expect(collectedTexts()).toEqual(
      expect.arrayContaining([expect.stringContaining("Started codex session")]),
    );
    relay.dispose();
  });

  it("can keep background relays out of the parent session while still logging", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-quiet",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-quiet",
      agentId: "codex",
      surfaceUpdates: false,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    relay.notifyStarted();
    emitAgentEvent({
      runId: "run-quiet",
      stream: "assistant",
      data: {
        delta: "hello from child",
      },
    });
    vi.advanceTimersByTime(15);
    emitAgentEvent({
      runId: "run-quiet",
      stream: "lifecycle",
      data: {
        phase: "end",
      },
    });

    expect(collectedTexts()).toEqual([]);
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
    relay.dispose();
  });

  it("preserves delta whitespace boundaries in progress relays", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-5",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-5",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-5",
      stream: "assistant",
      data: {
        delta: "hello",
      },
    });
    emitAgentEvent({
      runId: "run-5",
      stream: "assistant",
      data: {
        delta: " world",
      },
    });
    vi.advanceTimersByTime(15);

    const texts = collectedTexts();
    expect(texts).toEqual(expect.arrayContaining([expect.stringContaining("codex: hello world")]));
    relay.dispose();
  });

  it("suppresses commentary-phase assistant relay text", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-commentary",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-commentary",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-commentary",
      stream: "assistant",
      data: {
        delta: "checking thread context; then post a tight progress reply here.",
        phase: "commentary",
      },
    });
    vi.advanceTimersByTime(15);

    const texts = collectedTexts();
    expect(texts).not.toEqual(
      expect.arrayContaining([expect.stringContaining("checking thread context")]),
    );
    expect(texts).not.toEqual(
      expect.arrayContaining([expect.stringContaining("post a tight progress reply here")]),
    );
    relay.dispose();
  });

  it("still relays final_answer assistant text after suppressed commentary", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-final",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-final",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-final",
      stream: "assistant",
      data: {
        delta: "checking thread context; then post a tight progress reply here.",
        phase: "commentary",
      },
    });
    emitAgentEvent({
      runId: "run-final",
      stream: "assistant",
      data: {
        delta: "final answer ready",
        phase: "final_answer",
      },
    });
    vi.advanceTimersByTime(15);

    const texts = collectedTexts();
    expect(texts).not.toEqual(
      expect.arrayContaining([expect.stringContaining("checking thread context")]),
    );
    expect(texts).toEqual(
      expect.arrayContaining([expect.stringContaining("codex: final answer ready")]),
    );
    relay.dispose();
  });
});

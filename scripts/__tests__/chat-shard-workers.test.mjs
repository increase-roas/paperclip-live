import assert from "node:assert/strict";
import test from "node:test";
import { chatWorkerCount } from "../chat-shard-workers.mjs";

test("uses the cores the host can spare, capped at six", () => {
  assert.equal(chatWorkerCount({ cpuCount: 8, pinned: null }), 6);
  assert.equal(chatWorkerCount({ cpuCount: 16, pinned: null }), 6);
  assert.equal(chatWorkerCount({ cpuCount: 6, pinned: null }), 4);
  assert.equal(chatWorkerCount({ cpuCount: 4, pinned: null }), 2);
});

test("never drops below two workers on a small host", () => {
  assert.equal(chatWorkerCount({ cpuCount: 2, pinned: null }), 2);
  assert.equal(chatWorkerCount({ cpuCount: 1, pinned: null }), 2);
});

test("honours an explicit pin", () => {
  assert.equal(chatWorkerCount({ cpuCount: 32, pinned: 8 }), 8);
  assert.equal(chatWorkerCount({ cpuCount: 8, pinned: 1 }), 1);
  assert.equal(chatWorkerCount({ cpuCount: 8, pinned: Number.NaN }), 6);
  assert.equal(chatWorkerCount({ cpuCount: 8, pinned: 0 }), 6);
});

test("reads PAPERCLIP_CHAT_SHARD_WORKERS when no pin is passed", () => {
  const previous = process.env.PAPERCLIP_CHAT_SHARD_WORKERS;
  try {
    process.env.PAPERCLIP_CHAT_SHARD_WORKERS = "3";
    assert.equal(chatWorkerCount({ cpuCount: 8 }), 3);
    process.env.PAPERCLIP_CHAT_SHARD_WORKERS = "nonsense";
    assert.equal(chatWorkerCount({ cpuCount: 8 }), 6);
  } finally {
    if (previous === undefined) delete process.env.PAPERCLIP_CHAT_SHARD_WORKERS;
    else process.env.PAPERCLIP_CHAT_SHARD_WORKERS = previous;
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { immutableModuleSignalPlan } from "./signal-contract";

const future = "2999-01-01T00:00:00.000Z";
const expired = "2000-01-01T00:00:00.000Z";
const longPlan = {
  setup_candidate_id: "setup-1",
  status: "READY",
  direction: "LONG",
  planned_entry: 4392.26,
  planned_stop: 4390.2,
  planned_target: 4396.38
};

test("blocked setup never exposes a dormant plan", () => {
  const result = immutableModuleSignalPlan(
    { id: "setup-1", status: "BLOCKED", expires_at: future },
    longPlan
  );
  assert.equal(result, null);
});

test("entry-ready setup exposes its immutable plan", () => {
  const result = immutableModuleSignalPlan(
    { id: "setup-1", status: "LONG SETUP READY", expires_at: future },
    longPlan
  );
  assert.deepEqual(result, {
    status: "TRADE_PLANNED",
    direction: "LONG",
    entry: 4392.26,
    stop: 4390.2,
    target: 4396.38
  });
});

test("expired setup never exposes a dormant plan", () => {
  const result = immutableModuleSignalPlan(
    { id: "setup-1", status: "LONG SETUP READY", expires_at: expired },
    { ...longPlan, setup_expires_at: expired }
  );
  assert.equal(result, null);
});

test("active paper trade keeps its frozen execution geometry", () => {
  const result = immutableModuleSignalPlan(
    { id: "setup-1", status: "BLOCKED", expires_at: expired },
    {
      ...longPlan,
      setup_expires_at: expired,
      active_trade_id: "trade-1",
      actual_entry: 4392.26,
      actual_stop: 4390.2,
      actual_target: 4396.38
    }
  );
  assert.equal(result?.status, "PAPER_TRADE_OPENED");
});

test("closed trade and invalid directional geometry stay hidden", () => {
  assert.equal(immutableModuleSignalPlan(undefined, undefined, {
    outcome: "WIN",
    direction: "LONG",
    actual_entry: 4392.26,
    actual_stop: 4390.2,
    actual_target: 4396.38
  }), null);
  assert.equal(immutableModuleSignalPlan({
    status: "SHORT SETUP READY",
    expires_at: future,
    direction: "SHORT",
    entry_price: 4392.26,
    stop_price: 4390.2,
    target_price: 4396.38
  }), null);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  detectionStatus,
  resolveSetupStage,
  setupSteps,
} from "../src/telemetry/setup-view-model.ts";
import {
  BUDGET_CHOICES,
  budgetChoiceLabel,
  describeBudget,
} from "../src/settings-state.ts";

const SETUP = {
  first_run: true,
  listen_host: "127.0.0.1",
  listen_port: 20440,
  fh6_first_detected_unix_ms: null,
};

const CONFIGURED = {
  ...SETUP,
  first_run: false,
  fh6_first_detected_unix_ms: 1_700_000_000_000,
};

/// A snapshot with every counter at zero: nothing has arrived at all.
function snapshot(overrides = {}) {
  return {
    revision: 1,
    connection: "LISTENING",
    health: "LOST",
    protocol: null,
    protocol_confidence: 0,
    valid_packets: 0,
    invalid_packets: 0,
    valid_active_fh6: 0,
    valid_inactive_fh6: 0,
    invalid_fh6: 0,
    unknown_protocol: 0,
    input_packet_hz: 0,
    valid_frame_hz: 0,
    last_packet_age_ms: null,
    last_valid_frame_age_ms: null,
    receive_errors: 0,
    stale: true,
    frame: null,
    issues: [],
    transport_error: null,
    session: null,
    hub: {
      published: 0,
      recent_frames: 0,
      ring_capacity: 512,
      ring_evictions: 0,
      subscribers: 0,
      subscriber_drops: 0,
      last_drop_ms: null,
    },
    grace_period_ms: 10000,
    ...overrides,
  };
}

// ---------------------------------------------------------------- stages

test("setup guidance stays hidden until the first read arrives", () => {
  assert.equal(
    resolveSetupStage({ setup: null, sawFirstRun: false, dismissed: false }),
    "hidden",
  );
});

test("a configured installation never sees setup guidance", () => {
  assert.equal(
    resolveSetupStage({
      setup: CONFIGURED,
      sawFirstRun: false,
      dismissed: false,
    }),
    "hidden",
  );
});

test("a first run shows the instructions", () => {
  assert.equal(
    resolveSetupStage({ setup: SETUP, sawFirstRun: true, dismissed: false }),
    "instructions",
  );
});

test("the success state is shown to the user who was watching the instructions", () => {
  // The backend flips `first_run` within a quarter second of the first decoded
  // packet. Without the latch, that success would never be visible to anybody.
  assert.equal(
    resolveSetupStage({
      setup: CONFIGURED,
      sawFirstRun: true,
      dismissed: false,
    }),
    "detected",
  );
});

test("dismissing the success state hides it for the rest of the run", () => {
  assert.equal(
    resolveSetupStage({
      setup: CONFIGURED,
      sawFirstRun: true,
      dismissed: true,
    }),
    "hidden",
  );
  assert.equal(
    resolveSetupStage({ setup: SETUP, sawFirstRun: true, dismissed: true }),
    "hidden",
  );
});

// ----------------------------------------------------------------- steps

test("the steps name the address and port the backend actually reported", () => {
  const text = setupSteps(SETUP)
    .map((step) => step.text)
    .join(" ");
  assert.match(text, /127\.0\.0\.1/);
  assert.match(text, /20440/);
  assert.match(text, /Data Out/);
});

test("the steps follow the port the backend reports, not a hard-coded one", () => {
  const text = setupSteps({ ...SETUP, listen_port: 20441 })
    .map((step) => step.text)
    .join(" ");
  assert.match(text, /20441/);
  assert.ok(!text.includes("20440"));
});

test("first-run instructions never ask the user to understand the transport", () => {
  const text = setupSteps(SETUP)
    .map((step) => step.text)
    .join(" ")
    .toLowerCase();
  for (const jargon of ["udp", "datagram", "socket", "loopback", "packet"]) {
    assert.ok(
      !text.includes(jargon),
      `first-run text must not say "${jargon}"`,
    );
  }
});

// ------------------------------------------------------------- detection

test("nothing arriving is stated plainly, not as an error", () => {
  const status = detectionStatus(SETUP, snapshot());
  assert.equal(status.tone, "neutral");
  assert.match(status.text, /127\.0\.0\.1:20440/);
});

test("traffic that is not FH6 is distinguished from no traffic at all", () => {
  const status = detectionStatus(SETUP, snapshot({ unknown_protocol: 12 }));
  assert.equal(status.tone, "warn");
  assert.match(status.text, /not Forza Horizon 6/);
});

test("FH6 traffic that fails validation names the Data Out format", () => {
  const status = detectionStatus(SETUP, snapshot({ invalid_fh6: 3 }));
  assert.equal(status.tone, "warn");
  assert.match(status.text, /Data Out format/);
});

test("a detected protocol is reported as success", () => {
  const status = detectionStatus(SETUP, snapshot({ protocol: "fh6" }));
  assert.equal(status.tone, "good");
  assert.match(status.text, /Setup is complete/);
});

test("a port that could not be opened is reported as a failure, not as silence", () => {
  const status = detectionStatus(
    SETUP,
    snapshot({ transport_error: "address in use" }),
  );
  assert.equal(status.tone, "bad");
  assert.match(status.text, /20440/);
  assert.match(status.text, /address in use/);
});

test("a detected protocol outranks a stale transport error", () => {
  const status = detectionStatus(
    SETUP,
    snapshot({ protocol: "fh6", transport_error: "earlier failure" }),
  );
  assert.equal(status.tone, "good");
});

// -------------------------------------------------------- storage budget

test("every offered budget is either zero or at least a gigabyte", () => {
  for (const choice of BUDGET_CHOICES) {
    assert.ok(
      choice === 0 || choice >= 1024 * 1024 * 1024,
      `${choice} is too small to be offered`,
    );
  }
});

test("the budget labels name a size or say plainly that nothing is deleted", () => {
  assert.equal(budgetChoiceLabel(0), "Keep everything");
  assert.equal(budgetChoiceLabel(8 * 1024 * 1024 * 1024), "8 GB");
});

test("disabling the limit warns that the folder grows without bound", () => {
  const text = describeBudget({
    storage_budget_bytes: 0,
    storage_budget_from_environment: false,
    min_storage_budget_bytes: 1024 * 1024 * 1024,
    max_storage_budget_bytes: 1024 ** 4,
    default_storage_budget_bytes: 8 * 1024 * 1024 * 1024,
    fh6_first_detected_unix_ms: null,
    last_error: null,
    path: "settings.json",
  });
  assert.match(text, /never deletes/);
  assert.match(text, /without limit/);
});

test("an enabled limit states that the live session is never deleted", () => {
  const text = describeBudget({
    storage_budget_bytes: 8 * 1024 * 1024 * 1024,
    storage_budget_from_environment: false,
    min_storage_budget_bytes: 1024 * 1024 * 1024,
    max_storage_budget_bytes: 1024 ** 4,
    default_storage_budget_bytes: 8 * 1024 * 1024 * 1024,
    fh6_first_detected_unix_ms: null,
    last_error: null,
    path: "settings.json",
  });
  assert.match(text, /oldest/);
  assert.match(text, /never deleted/);
});

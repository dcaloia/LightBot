import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CycleRunner, pressSchedule } from '../cycle.js';

const MIN = 60000;

// A tiny virtual clock: timers fire in order when the clock is advanced.
function makeClock(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeoutFn(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        timers.delete(id);
        now = Math.max(now, t.at);
        await t.fn();
        await new Promise((r) => setImmediate(r)); // let awaited presses settle
      }
      now = target;
    },
    jump(ms) {
      now += ms;
    },
  };
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test('one hour every twelve minutes is five presses, starting now', () => {
  const times = pressSchedule({ startedAt: 0, durationMs: 60 * MIN, intervalMs: 12 * MIN });
  assert.deepEqual(times.map((t) => t / MIN), [0, 12, 24, 36, 48]);
  assert.deepEqual(pressSchedule({ startedAt: 0, durationMs: 60 * MIN, intervalMs: 12 * MIN, pressAtStart: false }).map((t) => t / MIN), [12, 24, 36, 48, 60]);
  assert.deepEqual(pressSchedule({ startedAt: 0, durationMs: 0, intervalMs: 12 * MIN }), []);
});

test('runs the whole cycle on schedule', async () => {
  const clock = makeClock();
  const presses = [];
  const changes = [];
  const runner = new CycleRunner({
    press: async () => presses.push(clock.now()),
    ...clock,
    onChange: (s) => changes.push(s),
  });
  const t0 = clock.now();
  runner.start();
  assert.equal(runner.state.total, 5);
  await clock.advance(1);
  assert.equal(presses.length, 1, 'presses immediately');
  await clock.advance(11 * MIN);
  assert.equal(presses.length, 1);
  await clock.advance(1 * MIN);
  assert.equal(presses.length, 2, 'second press at twelve minutes');
  await clock.advance(48 * MIN);
  assert.equal(presses.length, 5);
  assert.deepEqual(presses.map((p) => (p - t0) / MIN), [0, 12, 24, 36, 48]);
  assert.equal(runner.running, false);
  assert.equal(runner.state.finishedReason, 'finished');
  assert.equal(runner.state.nextAt, null);
  assert.ok(changes.length >= 10);
});

test('stop cancels the remaining presses', async () => {
  const clock = makeClock();
  let presses = 0;
  const runner = new CycleRunner({ press: async () => presses++, ...clock });
  runner.start();
  await clock.advance(13 * MIN);
  assert.equal(presses, 2);
  runner.stop();
  await clock.advance(60 * MIN);
  assert.equal(presses, 2);
  assert.equal(runner.state.finishedReason, 'stopped');
});

test('a failed press is recorded and the cycle carries on', async () => {
  const clock = makeClock();
  let n = 0;
  const runner = new CycleRunner({
    press: async () => {
      n++;
      if (n === 2) throw new Error('out of range');
    },
    ...clock,
  });
  runner.start();
  await clock.advance(61 * MIN);
  assert.equal(n, 5);
  assert.deepEqual(
    runner.state.results.map((r) => r.ok),
    [true, false, true, true, true],
  );
  assert.equal(runner.state.results[1].error, 'out of range');
});

test('sleeping through slots gives one catch-up press, not a burst', async () => {
  const clock = makeClock();
  let presses = 0;
  const runner = new CycleRunner({ press: async () => presses++, ...clock });
  runner.start();
  await clock.advance(1);
  assert.equal(presses, 1);
  clock.jump(40 * MIN); // phone was asleep: slots at 12, 24 and 36 were missed
  runner.poke();
  await clock.advance(1);
  assert.equal(presses, 2, 'one catch-up press');
  assert.equal(runner.state.completed, 4, 'the two extra overdue slots are skipped');
  assert.equal(runner.state.results.filter((r) => r.skipped).length, 2);
  await clock.advance(8 * MIN);
  assert.equal(presses, 3, 'the 48-minute press still happens');
  assert.equal(runner.running, false);
});

test('resumes a saved cycle after a reload', async () => {
  const clock = makeClock();
  const storage = memoryStorage();
  let presses = 0;
  const first = new CycleRunner({ press: async () => presses++, ...clock, storage });
  first.start();
  await clock.advance(25 * MIN);
  assert.equal(presses, 3);

  // "Reload": the old page (and its timer) is gone; a new runner shares the storage.
  clock.clearTimeoutFn(first.timer);
  first.timer = null;
  const second = new CycleRunner({ press: async () => presses++, ...clock, storage });
  assert.equal(second.resume(), true);
  assert.equal(second.state.completed, 3);
  assert.equal(second.state.total, 5);
  await clock.advance(11 * MIN);
  assert.equal(presses, 4);
  await clock.advance(30 * MIN);
  assert.equal(presses, 5);
  assert.equal(second.running, false);

  const third = new CycleRunner({ press: async () => presses++, ...clock, storage });
  assert.equal(third.resume(), false, 'a finished cycle does not resume');
});

test('a cycle that expired while the page was closed does not resume', async () => {
  const clock = makeClock();
  const storage = memoryStorage();
  const first = new CycleRunner({ press: async () => {}, ...clock, storage });
  first.start();
  await clock.advance(1);
  clock.jump(2 * 60 * MIN);
  const second = new CycleRunner({ press: async () => {}, ...clock, storage });
  assert.equal(second.resume(), false);
});

test('custom duration and interval', async () => {
  const clock = makeClock();
  let presses = 0;
  const runner = new CycleRunner({ press: async () => presses++, ...clock, durationMinutes: 30, intervalMinutes: 10 });
  runner.start();
  assert.equal(runner.state.total, 3);
  await clock.advance(31 * MIN);
  assert.equal(presses, 3);
});

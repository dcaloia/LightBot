// The "one hour, every 12 minutes" cycle. Pure scheduling logic with injectable clock
// and timers so it can be tested without waiting an hour.

const STORAGE_KEY = 'fingerbot.cycle';

// Press times for a cycle: at the start, then every interval, for as long as the
// cycle lasts. 60 minutes / 12 minutes gives presses at 0, 12, 24, 36 and 48.
export function pressSchedule({ startedAt, durationMs, intervalMs, pressAtStart = true }) {
  if (!(intervalMs > 0) || !(durationMs > 0)) return [];
  const times = [];
  for (let t = pressAtStart ? 0 : intervalMs; pressAtStart ? t < durationMs : t <= durationMs; t += intervalMs) {
    times.push(startedAt + t);
  }
  return times;
}

export class CycleRunner {
  constructor({
    press,
    durationMinutes = 60,
    intervalMinutes = 12,
    pressAtStart = true,
    now = () => Date.now(),
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn = (id) => clearTimeout(id),
    storage = null,
    onChange = () => {},
    log = () => {},
  }) {
    this.press = press;
    this.durationMinutes = durationMinutes;
    this.intervalMinutes = intervalMinutes;
    this.pressAtStart = pressAtStart;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.storage = storage;
    this.onChange = onChange;
    this.log = log;

    this.running = false;
    this.pressing = false;
    this.startedAt = null;
    this.schedule = [];
    this.completed = 0;
    this.results = []; // {at, scheduledAt, ok, error?, skipped?}
    this.timer = null;
    this.finishedReason = null;
  }

  get endsAt() {
    return this.startedAt === null ? null : this.startedAt + this.durationMinutes * 60000;
  }

  get nextAt() {
    return this.running && this.completed < this.schedule.length ? this.schedule[this.completed] : null;
  }

  get state() {
    return {
      running: this.running,
      pressing: this.pressing,
      startedAt: this.startedAt,
      endsAt: this.endsAt,
      nextAt: this.nextAt,
      completed: this.completed,
      total: this.schedule.length,
      results: this.results.slice(),
      finishedReason: this.finishedReason,
      durationMinutes: this.durationMinutes,
      intervalMinutes: this.intervalMinutes,
    };
  }

  start(startedAt = this.now()) {
    this.stop('restarted', { silent: true });
    this.startedAt = startedAt;
    this.schedule = pressSchedule({
      startedAt,
      durationMs: this.durationMinutes * 60000,
      intervalMs: this.intervalMinutes * 60000,
      pressAtStart: this.pressAtStart,
    });
    this.completed = 0;
    this.results = [];
    this.finishedReason = null;
    this.running = this.schedule.length > 0;
    this.log(`Cycle started: ${this.schedule.length} presses over ${this.durationMinutes} min, every ${this.intervalMinutes} min`);
    this.#persist();
    this.onChange(this.state);
    this.#arm();
  }

  stop(reason = 'stopped', { silent = false } = {}) {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    if (this.running) {
      this.running = false;
      this.finishedReason = reason;
      if (!silent) this.log(`Cycle ${reason}`);
    }
    this.#persist();
    if (!silent) this.onChange(this.state);
  }

  // Pick up a cycle that was running when the page was last closed or reloaded.
  resume() {
    if (!this.storage) return false;
    let saved = null;
    try {
      saved = JSON.parse(this.storage.getItem(STORAGE_KEY) || 'null');
    } catch {
      return false;
    }
    if (!saved || !saved.running) return false;
    this.durationMinutes = saved.durationMinutes;
    this.intervalMinutes = saved.intervalMinutes;
    this.pressAtStart = saved.pressAtStart;
    this.startedAt = saved.startedAt;
    this.schedule = pressSchedule({
      startedAt: saved.startedAt,
      durationMs: saved.durationMinutes * 60000,
      intervalMs: saved.intervalMinutes * 60000,
      pressAtStart: saved.pressAtStart,
    });
    this.completed = saved.completed || 0;
    this.results = saved.results || [];
    if (this.completed >= this.schedule.length || this.now() >= this.endsAt) {
      this.running = false;
      this.finishedReason = 'finished';
      this.#persist();
      return false;
    }
    this.running = true;
    this.finishedReason = null;
    this.log(`Resumed cycle: ${this.completed}/${this.schedule.length} presses done`);
    this.onChange(this.state);
    this.#arm();
    return true;
  }

  // Called by the page when it comes back to the foreground: timers may have been
  // throttled while hidden, so re-check whether a press is due.
  poke() {
    if (this.running && !this.pressing) this.#arm();
  }

  #arm() {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    if (!this.running) return;
    if (this.completed >= this.schedule.length) {
      this.stop('finished');
      return;
    }
    const delay = Math.max(0, this.schedule[this.completed] - this.now());
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.#fire().catch((err) => this.log(`Cycle error: ${err.message}`));
    }, delay);
  }

  async #fire() {
    if (!this.running || this.pressing) return;
    const scheduledAt = this.schedule[this.completed];
    this.pressing = true;
    this.onChange(this.state);
    const at = this.now();
    let result;
    try {
      await this.press();
      result = { at, scheduledAt, ok: true };
      this.log(`Cycle press ${this.completed + 1} of ${this.schedule.length} done`);
    } catch (err) {
      result = { at, scheduledAt, ok: false, error: err.message };
      this.log(`Cycle press ${this.completed + 1} of ${this.schedule.length} failed: ${err.message}`);
    }
    this.pressing = false;
    if (!this.running) return; // stopped while pressing
    this.results.push(result);
    this.completed += 1;
    // If the phone slept through several slots, one catch-up press is enough.
    const done = this.now();
    while (this.completed < this.schedule.length && this.schedule[this.completed] <= done) {
      this.results.push({ at: done, scheduledAt: this.schedule[this.completed], ok: false, skipped: true });
      this.log(`Skipped an overdue press scheduled for ${new Date(this.schedule[this.completed]).toLocaleTimeString()}`);
      this.completed += 1;
    }
    this.#persist();
    this.onChange(this.state);
    this.#arm();
  }

  #persist() {
    if (!this.storage) return;
    try {
      if (this.startedAt === null) {
        this.storage.removeItem(STORAGE_KEY);
        return;
      }
      this.storage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          running: this.running,
          startedAt: this.startedAt,
          durationMinutes: this.durationMinutes,
          intervalMinutes: this.intervalMinutes,
          pressAtStart: this.pressAtStart,
          completed: this.completed,
          results: this.results,
        }),
      );
    } catch {
      /* storage unavailable */
    }
  }
}

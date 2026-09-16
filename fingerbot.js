// High-level Fingerbot Plus control on top of a TuyaBleSession and a transport.
//
// Transport contract (see web-bluetooth.js and test/fake-device.mjs):
//   connect(onNotify)  -> resolves when notifications are flowing
//   write(Uint8Array)  -> one GATT fragment to the write characteristic
//   disconnect()

import { DpType, TuyaBleSession, TuyaBleError, toHex } from './tuya-ble.js?v=20260916-9';
import { describeError } from './web-bluetooth.js?v=20260916-9';

// Datapoints for the Fingerbot Plus (Tuya category "szjqr"; product ids blliqpsj,
// ndvkgsrm, yiihr7zh, neq16kgd). The original Fingerbot uses the same numbers.
export const FINGERBOT_DP = Object.freeze({
  switch: 2,
  mode: 8,
  downPosition: 9,
  holdTime: 10,
  reversePositions: 11,
  battery: 12,
  upPosition: 15,
  manualControl: 17,
  program: 121,
});

export const FingerbotMode = Object.freeze({ CLICK: 0, SWITCH: 1, PROGRAM: 2 });

const DP_LABELS = {
  2: 'switch',
  8: 'mode',
  9: 'down / press position',
  10: 'hold time (s)',
  11: 'reverse',
  12: 'battery %',
  15: 'up / rest position',
  17: 'manual control',
  121: 'program',
};
const DP_TYPE_NAMES = { 0: 'raw', 1: 'bool', 2: 'value', 3: 'string', 4: 'enum', 5: 'bitmap' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The on-device program (DP 121) is: 3 header bytes (kept as the device had them),
// a step count byte, then each step is [position 0-100][duration, uint16 big-endian].
// Format from the ha_tuya_ble project. The duration unit is the device's own (seconds
// on the units seen); we confirm it against the hardware with a short test first.
export function buildProgramBytes(header, steps) {
  const head = [header?.[0] ?? 0, header?.[1] ?? 0, header?.[2] ?? 0];
  const out = [...head, steps.length & 0xff];
  for (const s of steps) {
    const delay = Math.max(0, Math.min(0xffff, Math.round(s.delay)));
    out.push(s.position & 0xff, (delay >> 8) & 0xff, delay & 0xff);
  }
  return Uint8Array.from(out);
}

// Turn a "press then wait" cycle into the two-step program the device loops.
export function pressCycleSteps({ downPosition = 100, holdDelay = 1, idlePosition = 0, intervalDelay }) {
  return [
    { position: downPosition, delay: holdDelay },
    { position: idlePosition, delay: intervalDelay },
  ];
}

export class Fingerbot {
  constructor({ transport, credentials, log = () => {}, attempts = 3, settleMs = 300, stateWaitMs = 1500 }) {
    this.transport = transport;
    this.credentials = credentials;
    this.log = log;
    this.attempts = attempts;
    this.settleMs = settleMs;
    this.stateWaitMs = stateWaitMs;
    this.chain = Promise.resolve();
  }

  // One physical press. Connects, pairs, makes sure the device is in click mode, sets
  // the switch datapoint, then disconnects so the battery is not held on a connection.
  // Presses are serialised so a manual tap during a cycle cannot interleave.
  press() {
    const run = () => this.#pressWithRetry();
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  // Connect, read every datapoint the device reports, log them (raw ones as hex), and
  // disconnect. Used to capture the on-device program (DP 121) and current settings so
  // its byte format can be replicated exactly. Serialised with presses.
  readSettings({ waitMs = 2000 } = {}) {
    const run = () => this.#readSettingsOnce(waitMs);
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  async #readSettingsOnce(waitMs) {
    const { uuid, localKey, deviceId } = this.credentials;
    let session = null;
    await this.transport.connect((bytes) => session?.onNotification(bytes));
    try {
      session = new TuyaBleSession({
        uuid,
        localKey,
        deviceId,
        write: (bytes) => this.transport.write(bytes),
        log: this.log,
      });
      await session.initialize();
      // The device reports its datapoints shortly after pairing, on its own schedule.
      await sleep(waitMs);
      const entries = [...session.datapoints.entries()].sort((a, b) => a[0] - b[0]);
      const snapshot = {};
      this.log(`Device settings (${entries.length} datapoint${entries.length === 1 ? '' : 's'}, firmware ${session.deviceVersion || '?'}):`);
      for (const [id, dp] of entries) {
        const label = DP_LABELS[id] ? ` ${DP_LABELS[id]}` : '';
        const isRaw = dp.value instanceof Uint8Array;
        const shown = isRaw ? `raw ${toHex(dp.value)}` : String(dp.value);
        this.log(`  DP ${id}${label} [${DP_TYPE_NAMES[dp.type] || dp.type}] = ${shown}`);
        snapshot[id] = { type: dp.type, value: isRaw ? toHex(dp.value) : dp.value };
      }
      if (!(FINGERBOT_DP.program in snapshot)) {
        this.log('No program datapoint reported yet; try Read settings once more.');
      }
      return { snapshot, firmware: session.deviceVersion };
    } finally {
      session?.close('disconnected');
      try {
        await this.transport.disconnect();
      } catch (err) {
        this.log(`Disconnect: ${describeError(err)}`);
      }
    }
  }

  // Write a repeating program to the device and (optionally) switch it into program
  // mode so it runs on its own, phone closed. Reads the current DP 121 to keep its
  // 3-byte header. Returns the bytes written so the caller can show them.
  writeProgram(options) {
    const run = () => this.#writeProgramOnce(options);
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  async #writeProgramOnce({ downPosition = 100, holdDelay = 1, idlePosition = 0, intervalDelay = 720, start = true } = {}) {
    const { uuid, localKey, deviceId } = this.credentials;
    let session = null;
    await this.transport.connect((bytes) => session?.onNotification(bytes));
    try {
      session = new TuyaBleSession({ uuid, localKey, deviceId, write: (bytes) => this.transport.write(bytes), log: this.log });
      await session.initialize();
      const current = await session.waitForDatapoint(FINGERBOT_DP.program, this.stateWaitMs);
      if (!current || !(current.value instanceof Uint8Array)) {
        throw new Error('The device did not report a program datapoint, so its header is unknown. Tap Read settings and send me the log.');
      }
      const header = current.value.subarray(0, 3);
      const steps = pressCycleSteps({ downPosition, holdDelay, idlePosition, intervalDelay });
      const program = buildProgramBytes(header, steps);
      this.log(`Writing program ${toHex(program)} (press ${downPosition}% for ${holdDelay}, rest ${idlePosition}% for ${intervalDelay})`);
      await session.setDatapoints([{ id: FINGERBOT_DP.program, type: DpType.RAW, value: program }]);
      if (start) {
        this.log('Switching the Fingerbot into program mode');
        await session.setDatapoints([{ id: FINGERBOT_DP.mode, type: DpType.ENUM, value: FingerbotMode.PROGRAM }]);
      }
      await sleep(this.settleMs);
      return { program: toHex(program), header: toHex(header) };
    } finally {
      session?.close('disconnected');
      try {
        await this.transport.disconnect();
      } catch (err) {
        this.log(`Disconnect: ${describeError(err)}`);
      }
    }
  }

  // Take the device out of program mode, back to single-press (click) mode.
  stopProgram() {
    const run = () => this.#stopProgramOnce();
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  async #stopProgramOnce() {
    const { uuid, localKey, deviceId } = this.credentials;
    let session = null;
    await this.transport.connect((bytes) => session?.onNotification(bytes));
    try {
      session = new TuyaBleSession({ uuid, localKey, deviceId, write: (bytes) => this.transport.write(bytes), log: this.log });
      await session.initialize();
      this.log('Switching the Fingerbot back to click mode');
      await session.setDatapoints([{ id: FINGERBOT_DP.mode, type: DpType.ENUM, value: FingerbotMode.CLICK }]);
      await sleep(this.settleMs);
    } finally {
      session?.close('disconnected');
      try {
        await this.transport.disconnect();
      } catch (err) {
        this.log(`Disconnect: ${describeError(err)}`);
      }
    }
  }

  async #pressWithRetry() {
    let lastError;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        return await this.#pressOnce();
      } catch (err) {
        lastError = err;
        this.log(`Attempt ${attempt} failed: ${describeError(err)}`);
        if (err.name === 'NotFoundError' || err.code === 'NO_DEVICE') break; // needs user action
        if (attempt < this.attempts) await sleep(1000 * attempt);
      }
    }
    throw lastError;
  }

  async #pressOnce() {
    const { uuid, localKey, deviceId } = this.credentials;
    let session = null;
    const started = Date.now();
    await this.transport.connect((bytes) => session?.onNotification(bytes));
    try {
      session = new TuyaBleSession({
        uuid,
        localKey,
        deviceId,
        write: (bytes) => this.transport.write(bytes),
        log: this.log,
      });
      await session.initialize();

      const mode = await session.waitForDatapoint(FINGERBOT_DP.mode, this.stateWaitMs);
      if (mode && mode.value !== FingerbotMode.CLICK) {
        this.log(`Fingerbot is in mode ${mode.value}; switching to click mode`);
        await session.setDatapoints([{ id: FINGERBOT_DP.mode, type: DpType.ENUM, value: FingerbotMode.CLICK }]);
      }

      await session.setDatapoints([{ id: FINGERBOT_DP.switch, type: DpType.BOOL, value: true }]);
      // Let the device's state echo arrive before we drop the link.
      await sleep(this.settleMs);
      const ms = Date.now() - started;
      this.log(`Pressed (${ms} ms)`);
      return { ms, firmware: session.deviceVersion };
    } finally {
      session?.close('disconnected');
      try {
        await this.transport.disconnect();
      } catch (err) {
        this.log(`Disconnect: ${describeError(err)}`);
      }
    }
  }
}

export { TuyaBleError };

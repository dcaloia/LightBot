// High-level Fingerbot Plus control on top of a TuyaBleSession and a transport.
//
// Transport contract (see web-bluetooth.js and test/fake-device.mjs):
//   connect(onNotify)  -> resolves when notifications are flowing
//   write(Uint8Array)  -> one GATT fragment to the write characteristic
//   disconnect()

import { DpType, TuyaBleSession, TuyaBleError } from './tuya-ble.js?v=20260916-6';
import { describeError } from './web-bluetooth.js?v=20260916-6';

// Datapoints for the Fingerbot Plus (Tuya category "szjqr"; product ids blliqpsj,
// ndvkgsrm, yiihr7zh, neq16kgd). The original Fingerbot uses the same numbers.
export const FINGERBOT_DP = Object.freeze({
  switch: 2,
  mode: 8,
  downPosition: 9,
  holdTime: 10,
  reversePositions: 11,
  upPosition: 15,
  manualControl: 17,
  program: 121,
});

export const FingerbotMode = Object.freeze({ CLICK: 0, SWITCH: 1, PROGRAM: 2 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

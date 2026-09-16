// A pretend Fingerbot Plus that speaks the device side of the Tuya BLE protocol.
// Used by the Node protocol tests and by the browser end-to-end test (where it sits
// behind a fake navigator.bluetooth).

import {
  Code,
  DpType,
  FragmentAssembler,
  buildPackets,
  parseMessage,
  deriveLoginKey,
  deriveSessionKey,
  encodeDatapoints,
  decodeDatapoints,
  concat,
} from '../tuya-ble.js';

const encoder = new TextEncoder();

export class FakeFingerbot {
  constructor({ uuid, localKey, deviceId, mode = 0, protocolVersion = 3, srand, alreadyPaired = false, askTime = true } = {}) {
    this.uuid = uuid;
    this.localKey = localKey;
    this.deviceId = deviceId;
    this.protocolVersion = protocolVersion;
    this.srand = srand || crypto.getRandomValues(new Uint8Array(6));
    this.loginKey = deriveLoginKey(localKey);
    this.sessionKey = deriveSessionKey(localKey, this.srand);
    this.alreadyPaired = alreadyPaired;
    this.askTime = askTime;
    this.assembler = new FragmentAssembler();
    this.seq = 100;
    this.notify = null; // set by the transport: (Uint8Array) => void
    this.received = []; // decoded messages from the phone, for assertions
    this.presses = []; // timestamps of switch DP = true
    this.timeReplies = [];
    this.dps = new Map([
      [8, { type: DpType.ENUM, value: mode }],
      [2, { type: DpType.BOOL, value: false }],
      [9, { type: DpType.VALUE, value: 80 }],
      [10, { type: DpType.VALUE, value: 0 }],
      [11, { type: DpType.BOOL, value: false }],
      [15, { type: DpType.VALUE, value: 0 }],
      [17, { type: DpType.BOOL, value: false }],
      [12, { type: DpType.VALUE, value: 87 }],
      [121, { type: DpType.RAW, value: Uint8Array.of(0, 1, 0, 0, 100, 1, 0) }],
    ]);
    this.paired = false;
    this.busy = Promise.resolve();
  }

  get mode() {
    return this.dps.get(8).value;
  }

  programHex() {
    const dp = this.dps.get(121);
    return dp && dp.value instanceof Uint8Array ? Array.from(dp.value, (b) => b.toString(16).padStart(2, '0')).join('') : null;
  }

  // Phone wrote one fragment to the write characteristic.
  async write(fragment) {
    const whole = this.assembler.push(fragment);
    if (!whole) return;
    const msg = await parseMessage(whole, (flag) => (flag === 4 ? this.loginKey : flag === 5 ? this.sessionKey : null));
    this.received.push(msg);
    await this.handle(msg);
  }

  // The reply to DEVICE_INFO carries the srand the session key is derived from, so it
  // is the one message the device encrypts with the login key (flag 4).
  async send(code, data, responseTo = 0, { login = false } = {}) {
    const packets = await buildPackets({
      seq: this.seq++,
      code,
      data,
      responseTo,
      key: login ? this.loginKey : this.sessionKey,
      securityFlag: login ? 4 : 5,
      protocolVersion: this.protocolVersion,
    });
    for (const p of packets) this.notify?.(p);
  }

  async handle({ seq, code, data }) {
    switch (code) {
      case Code.FUN_SENDER_DEVICE_INFO: {
        const info = new Uint8Array(46);
        info[0] = 1; // firmware 1.2
        info[1] = 2;
        info[2] = this.protocolVersion;
        info[3] = 0;
        info[4] = 0;
        info[5] = this.alreadyPaired ? 1 : 0;
        info.set(this.srand, 6);
        info[12] = 1;
        info[13] = 0;
        crypto.getRandomValues(info.subarray(14, 46));
        await this.send(Code.FUN_SENDER_DEVICE_INFO, info, seq, { login: true });
        break;
      }
      case Code.FUN_SENDER_PAIR: {
        const uuid = new TextDecoder().decode(data.subarray(0, 16));
        const key6 = new TextDecoder().decode(data.subarray(16, 22));
        const devId = new TextDecoder().decode(data.subarray(22, 44)).replace(/\0+$/, '');
        const ok = uuid === this.uuid && key6 === this.localKey.slice(0, 6) && devId === this.deviceId;
        const result = !ok ? 1 : this.paired || this.alreadyPaired ? 2 : 0;
        if (ok) this.paired = true;
        await this.send(Code.FUN_SENDER_PAIR, Uint8Array.of(result), seq);
        if (ok && this.askTime) await this.send(Code.FUN_RECEIVE_TIME1_REQ, new Uint8Array(0));
        break;
      }
      case Code.FUN_SENDER_DEVICE_STATUS: {
        await this.send(Code.FUN_SENDER_DEVICE_STATUS, Uint8Array.of(this.paired ? 0 : 1), seq);
        if (this.paired) await this.reportAll();
        break;
      }
      case Code.FUN_SENDER_DPS: {
        if (!this.paired) {
          await this.send(Code.FUN_SENDER_DPS, Uint8Array.of(1), seq);
          break;
        }
        const dps = decodeDatapoints(data, 0);
        for (const dp of dps) {
          this.dps.set(dp.id, { type: dp.type, value: dp.value });
          if (dp.id === 2 && dp.value === true) this.presses.push(Date.now());
        }
        await this.send(Code.FUN_SENDER_DPS, Uint8Array.of(0), seq);
        // Echo the new state back, the way real devices do, and in click mode the
        // switch springs back to false after the press.
        const echo = dps.map((dp) => ({ id: dp.id, type: dp.type, value: dp.id === 2 && this.mode === 0 ? false : dp.value }));
        await this.send(Code.FUN_RECEIVE_SIGN_DP, concat(Uint8Array.of(0, 1, 0), encodeDatapoints(echo)));
        break;
      }
      case Code.FUN_RECEIVE_TIME1_REQ: {
        this.timeReplies.push(new TextDecoder().decode(data.subarray(0, 13)));
        break;
      }
      default:
        break;
    }
  }

  async reportAll() {
    const dps = Array.from(this.dps, ([id, { type, value }]) => ({ id, type, value }));
    await this.send(Code.FUN_RECEIVE_DP, encodeDatapoints(dps));
  }
}

// A transport that wires a TuyaBleSession straight to a FakeFingerbot in-process.
export function directTransport(device) {
  return {
    connected: false,
    async connect(onNotify) {
      this.connected = true;
      device.notify = (bytes) => queueMicrotask(() => onNotify(bytes));
    },
    async write(bytes) {
      if (!this.connected) throw new Error('not connected');
      await device.write(bytes);
    },
    async disconnect() {
      this.connected = false;
      device.notify = null;
    },
  };
}

export const TEST_CREDENTIALS = Object.freeze({
  uuid: 'tuya0123456789ab',
  localKey: 'k3yF0rT3st5=0nly',
  deviceId: 'ebtestdevice0001',
});

export { encoder };

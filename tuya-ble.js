// Tuya BLE protocol (the connected GATT one, protocol v3) in plain browser JavaScript.
//
// A port of the MIT-licensed Python library "tuya-ble" by Oleksandr Plias
// (https://github.com/PlusPlus-ua/tuya_ble), rewritten for WebCrypto so it can run in
// a phone browser with no server. The wire format:
//
//   plaintext  = seq(4) responseTo(4) code(2) len(2) data crc16(2) zero-pad-to-16
//   ciphertext = securityFlag(1) iv(16) AES-128-CBC(key, iv, plaintext)
//   fragments  = [varint packetNum] [varint totalLen, versionByte  -- first fragment only] bytes...
//                each fragment at most 20 bytes (GATT_MTU)
//
// Keys: loginKey = md5(localKey[:6]) for the DEVICE_INFO request (flag 4);
//       sessionKey = md5(localKey[:6] + srand) for everything after (flag 5).

import { md5 } from './md5.js?v=20260916-7';

export const SERVICE_UUID = '0000a201-0000-1000-8000-00805f9b34fb';
export const CHARACTERISTIC_NOTIFY = '00002b10-0000-1000-8000-00805f9b34fb';
export const CHARACTERISTIC_WRITE = '00002b11-0000-1000-8000-00805f9b34fb';
export const MANUFACTURER_DATA_ID = 0x07d0;
export const GATT_MTU = 20;

export const Code = Object.freeze({
  FUN_SENDER_DEVICE_INFO: 0x0000,
  FUN_SENDER_PAIR: 0x0001,
  FUN_SENDER_DPS: 0x0002,
  FUN_SENDER_DEVICE_STATUS: 0x0003,
  FUN_SENDER_UNBIND: 0x0005,
  FUN_SENDER_DEVICE_RESET: 0x0006,
  FUN_SENDER_DPS_V4: 0x0027,
  FUN_RECEIVE_DP: 0x8001,
  FUN_RECEIVE_TIME_DP: 0x8003,
  FUN_RECEIVE_SIGN_DP: 0x8004,
  FUN_RECEIVE_SIGN_TIME_DP: 0x8005,
  FUN_RECEIVE_DP_V4: 0x8006,
  FUN_RECEIVE_TIME_DP_V4: 0x8007,
  FUN_RECEIVE_TIME1_REQ: 0x8011,
  FUN_RECEIVE_TIME2_REQ: 0x8012,
});

const CODE_NAMES = Object.fromEntries(Object.entries(Code).map(([k, v]) => [v, k]));
export function codeName(code) {
  return CODE_NAMES[code] || `0x${code.toString(16)}`;
}

export const DpType = Object.freeze({
  RAW: 0,
  BOOL: 1,
  VALUE: 2,
  STRING: 3,
  ENUM: 4,
  BITMAP: 5,
});

export class TuyaBleError extends Error {}
export class TuyaBleFormatError extends TuyaBleError {}
export class TuyaBleCrcError extends TuyaBleError {}
export class TuyaBleDeviceError extends TuyaBleError {
  constructor(code) {
    super(`Device returned error code ${code}`);
    this.code = code;
  }
}
export class TuyaBleTimeoutError extends TuyaBleError {}

// ---------------------------------------------------------------------------
// Byte helpers

export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function crc16(data) {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte & 0xff;
    for (let i = 0; i < 8; i++) {
      const tmp = crc & 1;
      crc >>>= 1;
      if (tmp !== 0) crc ^= 0xa001;
    }
  }
  return crc;
}

export function packVarint(value) {
  const out = [];
  for (;;) {
    let b = value & 0x7f;
    value >>>= 7;
    if (value !== 0) b |= 0x80;
    out.push(b);
    if (value === 0) break;
  }
  return Uint8Array.from(out);
}

export function unpackVarint(data, start) {
  let result = 0;
  let offset = 0;
  while (offset < 5) {
    const pos = start + offset;
    if (pos >= data.length) throw new TuyaBleFormatError('varint runs past end of packet');
    const b = data[pos];
    result |= (b & 0x7f) << (offset * 7);
    offset += 1;
    if ((b & 0x80) === 0) break;
  }
  if (offset > 4) throw new TuyaBleFormatError('varint too long');
  return [result >>> 0, start + offset];
}

// ---------------------------------------------------------------------------
// AES-128-CBC without padding, on top of WebCrypto (which insists on PKCS#7).
// Encrypt: input is already a multiple of 16, so WebCrypto appends one full padding
// block; drop it. Decrypt: append a block that decrypts to valid padding, computed by
// encrypting an empty message chained from the last ciphertext block.

async function importAesKey(key) {
  return crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
}

export async function aesCbcEncryptNoPad(key, iv, data) {
  if (data.length % 16 !== 0) throw new TuyaBleFormatError('plaintext must be a multiple of 16 bytes');
  const k = await importAesKey(key);
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, data));
  return out.subarray(0, data.length);
}

export async function aesCbcDecryptNoPad(key, iv, data) {
  if (data.length % 16 !== 0) throw new TuyaBleFormatError('ciphertext must be a multiple of 16 bytes');
  const k = await importAesKey(key);
  const lastBlock = data.length ? data.subarray(data.length - 16) : iv;
  const padBlock = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CBC', iv: lastBlock }, k, new Uint8Array(0)),
  );
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k, concat(data, padBlock)));
}

// ---------------------------------------------------------------------------
// Packet building / parsing (pure functions so they can be unit tested).

export function deriveLoginKey(localKey) {
  return md5(encoder.encode(localKey.slice(0, 6)));
}

export function deriveSessionKey(localKey, srand) {
  return md5(concat(encoder.encode(localKey.slice(0, 6)), srand));
}

export async function buildPackets({ seq, code, data, responseTo = 0, key, securityFlag, iv, protocolVersion }) {
  const header = new Uint8Array(12);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, seq);
  hv.setUint32(4, responseTo);
  hv.setUint16(8, code);
  hv.setUint16(10, data.length);
  let raw = concat(header, data);
  const crc = new Uint8Array(2);
  new DataView(crc.buffer).setUint16(0, crc16(raw));
  raw = concat(raw, crc);
  const padded = new Uint8Array(Math.ceil(raw.length / 16) * 16);
  padded.set(raw);

  const ivBytes = iv || crypto.getRandomValues(new Uint8Array(16));
  const encrypted = concat(Uint8Array.of(securityFlag), ivBytes, await aesCbcEncryptNoPad(key, ivBytes, padded));

  const packets = [];
  let packetNum = 0;
  let pos = 0;
  while (pos < encrypted.length) {
    let head = packVarint(packetNum);
    if (packetNum === 0) {
      head = concat(head, packVarint(encrypted.length), Uint8Array.of((protocolVersion << 4) & 0xff));
    }
    const chunk = encrypted.subarray(pos, pos + GATT_MTU - head.length);
    packets.push(concat(head, chunk));
    pos += chunk.length;
    packetNum += 1;
  }
  return packets;
}

// Reassembles notification fragments into whole encrypted messages.
export class FragmentAssembler {
  constructor() {
    this.reset();
  }

  reset() {
    this.buffer = null;
    this.expectedPacketNum = 0;
    this.expectedLength = 0;
  }

  // Returns the complete encrypted message when the last fragment arrives, else null.
  push(data) {
    let [packetNum, pos] = unpackVarint(data, 0);
    if (packetNum < this.expectedPacketNum) {
      // Device restarted a message; drop what we had.
      this.reset();
    }
    if (packetNum !== this.expectedPacketNum) {
      this.reset();
      throw new TuyaBleFormatError(`missing fragment, expected ${this.expectedPacketNum} got ${packetNum}`);
    }
    if (packetNum === 0) {
      this.buffer = new Uint8Array(0);
      [this.expectedLength, pos] = unpackVarint(data, pos);
      pos += 1; // protocol version byte
    }
    this.buffer = concat(this.buffer, data.subarray(pos));
    this.expectedPacketNum += 1;
    if (this.buffer.length > this.expectedLength) {
      this.reset();
      throw new TuyaBleFormatError('fragment data longer than announced length');
    }
    if (this.buffer.length === this.expectedLength) {
      const whole = this.buffer;
      this.reset();
      return whole;
    }
    return null;
  }
}

export async function parseMessage(encrypted, keyForFlag) {
  const securityFlag = encrypted[0];
  const key = keyForFlag(securityFlag);
  if (!key) throw new TuyaBleFormatError(`no key for security flag ${securityFlag}`);
  const iv = encrypted.subarray(1, 17);
  const raw = await aesCbcDecryptNoPad(key, iv, encrypted.subarray(17));
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const seq = view.getUint32(0);
  const responseTo = view.getUint32(4);
  const code = view.getUint16(8);
  const length = view.getUint16(10);
  const dataEnd = 12 + length;
  if (raw.length < dataEnd) throw new TuyaBleFormatError('message shorter than its length field');
  if (raw.length > dataEnd + 1) {
    const expected = view.getUint16(dataEnd);
    const actual = crc16(raw.subarray(0, dataEnd));
    if (expected !== actual) throw new TuyaBleCrcError(`crc mismatch ${expected} != ${actual}`);
  }
  return { seq, responseTo, code, data: raw.slice(12, dataEnd) };
}

export function encodeDpValue(type, value) {
  switch (type) {
    case DpType.RAW:
    case DpType.BITMAP:
      return value instanceof Uint8Array ? value : Uint8Array.from(value);
    case DpType.BOOL:
      return Uint8Array.of(value ? 1 : 0);
    case DpType.VALUE: {
      const out = new Uint8Array(4);
      new DataView(out.buffer).setInt32(0, value);
      return out;
    }
    case DpType.ENUM: {
      if (value < 0) throw new TuyaBleFormatError('enum values are unsigned');
      if (value > 0xffff) {
        const out = new Uint8Array(4);
        new DataView(out.buffer).setUint32(0, value);
        return out;
      }
      if (value > 0xff) {
        const out = new Uint8Array(2);
        new DataView(out.buffer).setUint16(0, value);
        return out;
      }
      return Uint8Array.of(value);
    }
    case DpType.STRING:
      return encoder.encode(String(value));
    default:
      throw new TuyaBleFormatError(`unknown datapoint type ${type}`);
  }
}

export function encodeDatapoints(dps) {
  const parts = [];
  for (const dp of dps) {
    const value = encodeDpValue(dp.type, dp.value);
    parts.push(Uint8Array.of(dp.id, dp.type, value.length), value);
  }
  return concat(...parts);
}

export function decodeDatapoints(data, start = 0) {
  const out = [];
  let pos = start;
  while (data.length - pos >= 4) {
    const id = data[pos++];
    const type = data[pos++];
    if (type > DpType.BITMAP) throw new TuyaBleFormatError(`unknown datapoint type ${type}`);
    const len = data[pos++];
    const next = pos + len;
    if (next > data.length) throw new TuyaBleFormatError('datapoint runs past end of message');
    const rawValue = data.slice(pos, next);
    let value;
    switch (type) {
      case DpType.RAW:
      case DpType.BITMAP:
        value = rawValue;
        break;
      case DpType.BOOL:
        value = rawValue.some((b) => b !== 0);
        break;
      case DpType.VALUE:
      case DpType.ENUM: {
        // Big-endian, signed, arbitrary width (1, 2 or 4 bytes in practice).
        let v = 0;
        for (const b of rawValue) v = (v << 8) | b;
        const bits = rawValue.length * 8;
        if (bits > 0 && bits < 32 && v & (1 << (bits - 1))) v -= 1 << bits;
        value = v;
        break;
      }
      case DpType.STRING:
        value = decoder.decode(rawValue);
        break;
    }
    out.push({ id, type, value });
    pos = next;
  }
  return out;
}

function parseTimestamp(data, start) {
  if (start >= data.length) throw new TuyaBleFormatError('missing timestamp');
  const timeType = data[start];
  let pos = start + 1;
  if (timeType === 0) {
    if (pos + 13 > data.length) throw new TuyaBleFormatError('short timestamp');
    return [parseInt(decoder.decode(data.subarray(pos, pos + 13)), 10), pos + 13];
  }
  if (timeType === 1) {
    if (pos + 4 > data.length) throw new TuyaBleFormatError('short timestamp');
    return [new DataView(data.buffer, data.byteOffset + pos, 4).getUint32(0) * 1000, pos + 4];
  }
  throw new TuyaBleFormatError(`unknown timestamp type ${timeType}`);
}

// ---------------------------------------------------------------------------
// A session with one device. The caller owns the transport: it passes a `write`
// function that pushes one GATT fragment to the write characteristic, and feeds every
// notification into `onNotification`.

export class TuyaBleSession {
  constructor({ uuid, localKey, deviceId, write, protocolVersion = 3, responseTimeoutMs = 10000, log = () => {}, now = () => Date.now() }) {
    if (!uuid || !localKey || !deviceId) throw new TuyaBleError('uuid, localKey and deviceId are required');
    this.uuid = uuid;
    this.localKey = localKey;
    this.deviceId = deviceId;
    this.write = write;
    this.protocolVersion = protocolVersion;
    this.responseTimeoutMs = responseTimeoutMs;
    this.log = log;
    this.now = now;

    this.loginKey = deriveLoginKey(localKey);
    this.sessionKey = null;
    this.authKey = null;

    this.seq = 1;
    this.pending = new Map(); // seq -> {resolve, reject}
    this.assembler = new FragmentAssembler();
    this.datapoints = new Map(); // id -> {type, value, timestamp}
    this.datapointListeners = new Set();
    this.opChain = Promise.resolve();
    this.deviceVersion = '';
    this.hardwareVersion = '';
    this.isBound = false;
    this.flags = 0;
    this.closed = false;
  }

  onDatapoints(listener) {
    this.datapointListeners.add(listener);
    return () => this.datapointListeners.delete(listener);
  }

  // Resolves with the datapoint once the device has reported it, or null after the
  // timeout. Devices send their first state report shortly after pairing, on their
  // own schedule, so callers that need a value should wait for it rather than assume.
  waitForDatapoint(id, timeoutMs = 1500) {
    if (this.datapoints.has(id)) return Promise.resolve(this.datapoints.get(id));
    return new Promise((resolve) => {
      let off = () => {};
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
      off = this.onDatapoints(() => {
        if (this.datapoints.has(id)) {
          clearTimeout(timer);
          off();
          resolve(this.datapoints.get(id));
        }
      });
    });
  }

  // Full handshake: device info (gets srand for the session key), pair, then ask for
  // the current state so the device reports its datapoints.
  async initialize() {
    this.log('Requesting device info');
    await this.sendPacket(Code.FUN_SENDER_DEVICE_INFO, new Uint8Array(0));

    const pairData = new Uint8Array(44);
    pairData.set(encoder.encode(this.uuid), 0);
    pairData.set(encoder.encode(this.localKey.slice(0, 6)), 16);
    pairData.set(encoder.encode(this.deviceId), 22);
    this.log('Pairing');
    await this.sendPacket(Code.FUN_SENDER_PAIR, pairData);

    // Give the device a moment to send its time request and first datapoints.
    await new Promise((r) => setTimeout(r, 500));

    this.log('Requesting device status');
    await this.sendPacket(Code.FUN_SENDER_DEVICE_STATUS, new Uint8Array(0));
  }

  async setDatapoints(dps) {
    if (this.protocolVersion !== 3) {
      throw new TuyaBleDeviceError(`unsupported protocol version ${this.protocolVersion}`);
    }
    for (const dp of dps) {
      this.log(`Sending DP ${dp.id} = ${dp.value}`);
    }
    await this.sendPacket(Code.FUN_SENDER_DPS, encodeDatapoints(dps));
  }

  close(reason = 'closed') {
    this.closed = true;
    for (const [seq, p] of this.pending) {
      this.pending.delete(seq);
      p.reject(new TuyaBleError(`connection ${reason} while waiting for response to #${seq}`));
    }
  }

  keyForFlag(flag) {
    if (flag === 1) return this.authKey;
    if (flag === 4) return this.loginKey;
    if (flag === 5) return this.sessionKey;
    return null;
  }

  // Serialises sends so seq numbers and responses stay matched.
  sendPacket(code, data, { responseTo = 0, waitForResponse = true } = {}) {
    const run = () => this.#sendNow(code, data, responseTo, waitForResponse);
    const result = this.opChain.then(run, run);
    this.opChain = result.catch(() => {});
    return result;
  }

  async #sendNow(code, data, responseTo, waitForResponse) {
    if (this.closed) throw new TuyaBleError('session is closed');
    const seq = this.seq++;
    const isInfo = code === Code.FUN_SENDER_DEVICE_INFO;
    const key = isInfo ? this.loginKey : this.sessionKey;
    if (!key) throw new TuyaBleError('no session key yet; run initialize() first');

    let waiter = null;
    if (waitForResponse) {
      waiter = new Promise((resolve, reject) => this.pending.set(seq, { resolve, reject }));
    }
    const packets = await buildPackets({
      seq,
      code,
      data,
      responseTo,
      key,
      securityFlag: isInfo ? 4 : 5,
      protocolVersion: this.protocolVersion,
    });
    this.log(`> #${seq} ${codeName(code)} (${packets.length} fragment${packets.length === 1 ? '' : 's'})`);
    for (const p of packets) await this.write(p);

    if (!waiter) return 0;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new TuyaBleTimeoutError(`no response to #${seq} ${codeName(code)} within ${this.responseTimeoutMs} ms`));
      }, this.responseTimeoutMs);
    });
    try {
      return await Promise.race([waiter, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Feed every notification fragment here. Never throws; problems are logged.
  onNotification(bytes) {
    let whole;
    try {
      whole = this.assembler.push(bytes);
    } catch (err) {
      this.log(`Bad fragment: ${err.message}`);
      return;
    }
    if (!whole) return;
    parseMessage(whole, (flag) => this.keyForFlag(flag))
      .then((msg) => this.#handle(msg))
      .catch((err) => this.log(`Bad message: ${err.message}`));
  }

  #handle({ seq, responseTo, code, data }) {
    this.log(`< #${seq} ${codeName(code)}${responseTo ? ` (reply to #${responseTo})` : ''}`);
    let result = 0;
    switch (code) {
      case Code.FUN_SENDER_DEVICE_INFO: {
        if (data.length < 46) throw new TuyaBleFormatError('short device info');
        this.deviceVersion = `${data[0]}.${data[1]}`;
        this.hardwareVersion = `${data[12]}.${data[13]}`;
        this.protocolVersion = data[2];
        this.flags = data[4];
        this.isBound = data[5] !== 0;
        const srand = data.subarray(6, 12);
        this.sessionKey = deriveSessionKey(this.localKey, srand);
        this.authKey = data.slice(14, 46);
        this.log(`Device firmware ${this.deviceVersion}, protocol ${this.protocolVersion}.${data[3]}, bound=${this.isBound}`);
        break;
      }
      case Code.FUN_SENDER_PAIR: {
        if (data.length !== 1) throw new TuyaBleFormatError('bad pair reply');
        result = data[0];
        if (result === 2) {
          this.log('Already paired');
          result = 0;
        }
        break;
      }
      case Code.FUN_SENDER_DEVICE_STATUS:
      case Code.FUN_SENDER_DPS: {
        if (data.length >= 1) result = data[0];
        break;
      }
      case Code.FUN_RECEIVE_TIME1_REQ: {
        const ms = String(this.now());
        const tz = new Uint8Array(2);
        new DataView(tz.buffer).setInt16(0, this.#timezoneHundredths());
        this.#reply(code, concat(encoder.encode(ms), tz), seq);
        break;
      }
      case Code.FUN_RECEIVE_TIME2_REQ: {
        const d = new Date(this.now());
        const out = new Uint8Array(9);
        out[0] = d.getFullYear() % 100;
        out[1] = d.getMonth() + 1;
        out[2] = d.getDate();
        out[3] = d.getHours();
        out[4] = d.getMinutes();
        out[5] = d.getSeconds();
        out[6] = (d.getDay() + 6) % 7; // Monday = 0, like C's tm_wday shifted the Tuya way
        new DataView(out.buffer).setInt16(7, this.#timezoneHundredths());
        this.#reply(code, out, seq);
        break;
      }
      case Code.FUN_RECEIVE_DP: {
        this.#updateDatapoints(decodeDatapoints(data, 0), this.now());
        this.#reply(code, new Uint8Array(0), seq);
        break;
      }
      case Code.FUN_RECEIVE_SIGN_DP: {
        const dpSeq = (data[0] << 8) | data[1];
        const flags = data[2];
        this.#updateDatapoints(decodeDatapoints(data, 3), this.now());
        this.#reply(code, Uint8Array.of(dpSeq >> 8, dpSeq & 0xff, flags, 0), seq);
        break;
      }
      case Code.FUN_RECEIVE_TIME_DP: {
        const [ts, pos] = parseTimestamp(data, 0);
        this.#updateDatapoints(decodeDatapoints(data, pos), ts);
        this.#reply(code, new Uint8Array(0), seq);
        break;
      }
      case Code.FUN_RECEIVE_SIGN_TIME_DP: {
        const dpSeq = (data[0] << 8) | data[1];
        const flags = data[2];
        const [ts, pos] = parseTimestamp(data, 3);
        this.#updateDatapoints(decodeDatapoints(data, pos), ts);
        this.#reply(code, Uint8Array.of(dpSeq >> 8, dpSeq & 0xff, flags, 0), seq);
        break;
      }
      default:
        break;
    }

    if (responseTo !== 0) {
      const p = this.pending.get(responseTo);
      if (p) {
        this.pending.delete(responseTo);
        if (result === 0) p.resolve(result);
        else p.reject(new TuyaBleDeviceError(result));
      }
    }
  }

  #timezoneHundredths() {
    // Hundredths of an hour east of UTC, e.g. -400 for UTC-4.
    return Math.round((-new Date(this.now()).getTimezoneOffset() * 100) / 60);
  }

  #reply(code, data, responseTo) {
    this.sendPacket(code, data, { responseTo, waitForResponse: false }).catch((err) =>
      this.log(`Failed to answer ${codeName(code)}: ${err.message}`),
    );
  }

  #updateDatapoints(dps, timestamp) {
    for (const dp of dps) {
      this.datapoints.set(dp.id, { type: dp.type, value: dp.value, timestamp });
      this.log(`DP ${dp.id} = ${dp.value instanceof Uint8Array ? toHex(dp.value) : dp.value}`);
    }
    for (const listener of this.datapointListeners) listener(dps);
  }
}

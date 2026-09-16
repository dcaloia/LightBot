// Web Bluetooth transport for the Tuya BLE session.
//
// Works in Chrome/Edge on Android, Chrome on desktop, and the Bluefy or WebBLE apps
// on iPhone (Safari itself has no Web Bluetooth). GitHub Pages is HTTPS, which the
// API requires.

import { SERVICE_UUID, CHARACTERISTIC_NOTIFY, CHARACTERISTIC_WRITE } from './tuya-ble.js?v=20260916-6';

const STORAGE_KEY = 'fingerbot.bluetoothDeviceId';

// Some bridges (Bluefy on iOS, for one) throw strings or bare objects instead of
// Errors, and report 16-bit UUIDs in short form ("a201", "0xA201", "A201"). These two
// helpers keep the log readable and the lookups tolerant.
export function describeError(err) {
  if (err === undefined || err === null) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message;
  if (err.name) return String(err.name);
  try {
    const json = JSON.stringify(err);
    if (json && json !== '{}') return json;
  } catch {
    /* not serialisable */
  }
  return String(err);
}

export function normalizeUuid(uuid) {
  if (typeof uuid === 'number') uuid = uuid.toString(16);
  let s = String(uuid).trim().toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{1,8}$/.test(s)) s = `${s.padStart(8, '0')}-0000-1000-8000-00805f9b34fb`;
  return s;
}

export function sameUuid(a, b) {
  return normalizeUuid(a) === normalizeUuid(b);
}

// Try the spec'd lookup first, then the enumerate-and-match fallback.
async function findService(server, uuid, log) {
  try {
    return await server.getPrimaryService(uuid);
  } catch (err) {
    log(`getPrimaryService failed (${describeError(err)}); listing services`);
  }
  const short = parseInt(normalizeUuid(uuid).slice(0, 8), 16);
  try {
    return await server.getPrimaryService(short);
  } catch {
    /* fall through */
  }
  const services = (await server.getPrimaryServices?.()) || [];
  log(`Services: ${services.map((s) => s.uuid).join(', ') || 'none'}`);
  const match = services.find((s) => sameUuid(s.uuid, uuid));
  if (!match) throw new Error(`Tuya service ${uuid} not found on this device`);
  return match;
}

async function findCharacteristic(service, uuid, log) {
  try {
    return await service.getCharacteristic(uuid);
  } catch (err) {
    log(`getCharacteristic failed (${describeError(err)}); listing characteristics`);
  }
  const short = parseInt(normalizeUuid(uuid).slice(0, 8), 16);
  try {
    return await service.getCharacteristic(short);
  } catch {
    /* fall through */
  }
  const chars = (await service.getCharacteristics?.()) || [];
  log(`Characteristics: ${chars.map((c) => c.uuid).join(', ') || 'none'}`);
  const match = chars.find((c) => sameUuid(c.uuid, uuid));
  if (!match) throw new Error(`Characteristic ${uuid} not found`);
  return match;
}

export class NoDeviceError extends Error {
  constructor() {
    super('No Fingerbot chosen yet. Tap "Pair Fingerbot" first.');
    this.code = 'NO_DEVICE';
  }
}

export class WebBluetoothTransport {
  constructor({ log = () => {}, connectTimeoutMs = 15000 } = {}) {
    this.log = log;
    this.connectTimeoutMs = connectTimeoutMs;
    this.device = null;
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.onNotify = null;
    this.onDisconnected = () => {};
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  get deviceName() {
    return this.device ? this.device.name || this.device.id : null;
  }

  // Must be called from a user gesture (a tap). Shows the browser's device chooser.
  async pickDevice({ anyDevice = false } = {}) {
    const options = anyDevice
      ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
      : { filters: [{ services: [SERVICE_UUID] }], optionalServices: [SERVICE_UUID] };
    const device = await navigator.bluetooth.requestDevice(options);
    this.#adopt(device);
    try {
      localStorage.setItem(STORAGE_KEY, device.id);
    } catch {
      /* private mode etc. */
    }
    this.log(`Chose ${this.deviceName}`);
    return device;
  }

  // Reuse a device chosen on an earlier visit, where the browser supports it
  // (Chrome on Android and desktop with the persistent-permissions backend).
  async restoreDevice() {
    if (this.device) return this.device;
    let wanted = null;
    try {
      wanted = localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
    if (!wanted || !navigator.bluetooth.getDevices) return null;
    try {
      const devices = await navigator.bluetooth.getDevices();
      const match = devices.find((d) => d.id === wanted);
      if (match) {
        this.#adopt(match);
        this.log(`Remembered ${this.deviceName}`);
        return match;
      }
    } catch (err) {
      this.log(`getDevices: ${describeError(err)}`);
    }
    return null;
  }

  forgetDevice() {
    this.device = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  #adopt(device) {
    if (this.device && this.device !== device) {
      this.device.removeEventListener('gattserverdisconnected', this.#handleDisconnect);
    }
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.#handleDisconnect);
  }

  #handleDisconnect = () => {
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.log('Bluetooth link closed');
    this.onDisconnected();
  };

  async connect(onNotify) {
    this.onNotify = onNotify;
    if (!this.device) await this.restoreDevice();
    if (!this.device) throw new NoDeviceError();

    this.log(`Connecting to ${this.deviceName}`);
    const gatt = this.device.gatt;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Could not reach the Fingerbot within ${this.connectTimeoutMs / 1000} s. Is it in range and awake?`));
        gatt.disconnect();
      }, this.connectTimeoutMs);
    });
    let stage = 'GATT connect';
    try {
      this.server = (await Promise.race([gatt.connect(), timeout])) || gatt;
      this.log('GATT connected');
      stage = 'service lookup';
      const service = await Promise.race([findService(this.server, SERVICE_UUID, this.log), timeout]);
      stage = 'characteristic lookup';
      this.notifyChar = await findCharacteristic(service, CHARACTERISTIC_NOTIFY, this.log);
      this.writeChar = await findCharacteristic(service, CHARACTERISTIC_WRITE, this.log);
      stage = 'start notifications';
      this.notifyChar.addEventListener('characteristicvaluechanged', this.#handleNotification);
      await Promise.race([this.notifyChar.startNotifications(), timeout]);
      this.log('Connected, notifications on');
    } catch (err) {
      try {
        gatt.disconnect();
      } catch {
        /* ignore */
      }
      const wrapped = new Error(`${stage} failed: ${describeError(err)}`);
      wrapped.name = err?.name || 'BluetoothError';
      wrapped.cause = err;
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }
  }

  #handleNotification = (event) => {
    const dv = event.target.value;
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    this.onNotify?.(bytes);
  };

  async write(bytes) {
    if (!this.writeChar) throw new Error('not connected');
    try {
      if (this.writeChar.writeValueWithoutResponse) {
        await this.writeChar.writeValueWithoutResponse(bytes);
      } else {
        await this.writeChar.writeValue(bytes);
      }
    } catch (err) {
      throw new Error(`write failed: ${describeError(err)}`);
    }
  }

  async disconnect() {
    const { notifyChar, device } = this;
    this.onNotify = null;
    if (notifyChar) {
      notifyChar.removeEventListener('characteristicvaluechanged', this.#handleNotification);
      try {
        await notifyChar.stopNotifications();
      } catch {
        /* link may already be gone */
      }
    }
    this.writeChar = null;
    this.notifyChar = null;
    this.server = null;
    if (device?.gatt?.connected) device.gatt.disconnect();
  }
}

// Web Bluetooth transport for the Tuya BLE session.
//
// Works in Chrome/Edge on Android, Chrome on desktop, and the Bluefy or WebBLE apps
// on iPhone (Safari itself has no Web Bluetooth). GitHub Pages is HTTPS, which the
// API requires.

import { SERVICE_UUID, CHARACTERISTIC_NOTIFY, CHARACTERISTIC_WRITE } from './tuya-ble.js?v=20260916-8';

const STORAGE_KEY = 'fingerbot.bluetoothDeviceId';

// Tuya devices expose one of two GATT services with the same characteristics and the
// same wire protocol: the original "a201" and the newer "1910" that current Fingerbot
// Plus units use. We accept either, and enumerate as a last resort.
const ALT_SERVICE_UUID = '00001910-0000-1000-8000-00805f9b34fb';
const SERVICE_UUIDS = [SERVICE_UUID, ALT_SERVICE_UUID];

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

async function getServiceByUuid(server, uuid) {
  try {
    return await server.getPrimaryService(uuid);
  } catch {
    /* try short form */
  }
  const short = parseInt(normalizeUuid(uuid).slice(0, 8), 16);
  try {
    return await server.getPrimaryService(short);
  } catch {
    return null;
  }
}

// Open whichever Tuya service the device offers. Tries each known UUID directly, then
// enumerates and matches by UUID, then as a last resort picks any service that holds a
// write and a notify characteristic.
async function openService(server, log) {
  for (const uuid of SERVICE_UUIDS) {
    const svc = await getServiceByUuid(server, uuid);
    if (svc) return svc;
  }
  let services = [];
  try {
    services = (await server.getPrimaryServices?.()) || [];
  } catch (err) {
    log(`Listing services failed (${describeError(err)})`);
  }
  log(`Services: ${services.map((s) => s.uuid).join(', ') || 'none'}`);
  const known = services.find((s) => SERVICE_UUIDS.some((u) => sameUuid(u, s.uuid)));
  if (known) return known;
  for (const s of services) {
    const chars = await listCharacteristics(s);
    const hasWrite = chars.some((c) => c.properties?.write || c.properties?.writeWithoutResponse);
    const hasNotify = chars.some((c) => c.properties?.notify || c.properties?.indicate);
    if (hasWrite && hasNotify) {
      log(`Using service ${s.uuid} (has write + notify characteristics)`);
      return s;
    }
  }
  throw new Error(`No Tuya service on this device (services: ${services.map((s) => s.uuid).join(', ') || 'none'})`);
}

async function listCharacteristics(service) {
  try {
    return (await service.getCharacteristics?.()) || [];
  } catch {
    return [];
  }
}

function propsOf(c) {
  const p = c.properties || {};
  return ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter((k) => p[k]).join('+') || 'none';
}

// Find the write / notify characteristic under a service: by UUID first, then by the
// capability every Tuya build shares (write-without-response for commands, notify for
// replies), so a device whose characteristic UUIDs differ still works.
async function pickCharacteristic(service, uuid, kind, log) {
  const svc = service;
  let direct = null;
  try {
    direct = await svc.getCharacteristic(uuid);
  } catch {
    const short = parseInt(normalizeUuid(uuid).slice(0, 8), 16);
    try {
      direct = await svc.getCharacteristic(short);
    } catch {
      /* enumerate below */
    }
  }
  if (direct) return direct;

  const chars = await listCharacteristics(svc);
  log(`Characteristics: ${chars.map((c) => `${c.uuid}[${propsOf(c)}]`).join(', ') || 'none'}`);
  let match = chars.find((c) => sameUuid(c.uuid, uuid));
  if (match) return match;
  match = chars.find((c) =>
    kind === 'write' ? c.properties?.write || c.properties?.writeWithoutResponse : c.properties?.notify || c.properties?.indicate,
  );
  if (match) {
    log(`Using ${match.uuid} as the ${kind} characteristic`);
    return match;
  }
  throw new Error(`No ${kind} characteristic on this service`);
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
      ? { acceptAllDevices: true, optionalServices: SERVICE_UUIDS }
      : { filters: SERVICE_UUIDS.map((s) => ({ services: [s] })), optionalServices: SERVICE_UUIDS };
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
      const service = await Promise.race([openService(this.server, this.log), timeout]);
      this.log(`Using service ${service.uuid}`);
      stage = 'characteristic lookup';
      this.notifyChar = await pickCharacteristic(service, CHARACTERISTIC_NOTIFY, 'notify', this.log);
      this.writeChar = await pickCharacteristic(service, CHARACTERISTIC_WRITE, 'write', this.log);
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

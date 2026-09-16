// A stand-in for navigator.bluetooth so the page can be driven end to end in headless
// Chromium. One FakeFingerbot sits behind a fake BluetoothDevice.

import { FakeFingerbot, TEST_CREDENTIALS } from './fake-device.mjs';
import { SERVICE_UUID, CHARACTERISTIC_NOTIFY, CHARACTERISTIC_WRITE } from '../tuya-ble.js';
import { sameUuid } from '../web-bluetooth.js';

class Emitter {
  #listeners = new Map();
  addEventListener(type, fn) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.#listeners.get(type)?.delete(fn);
  }
  emit(type, event) {
    for (const fn of this.#listeners.get(type) || []) fn(event);
  }
}

class FakeCharacteristic extends Emitter {
  constructor(uuid, device, properties) {
    super();
    this.uuid = uuid;
    this.device = device;
    this.value = null;
    this.properties = properties || { write: true, writeWithoutResponse: true, notify: true };
  }
  async startNotifications() {
    this.device.fingerbot.notify = (bytes) => {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.value = dv;
      this.emit('characteristicvaluechanged', { target: this });
    };
    return this;
  }
  async stopNotifications() {
    this.device.fingerbot.notify = null;
    return this;
  }
  async writeValueWithoutResponse(bytes) {
    if (!this.device.gatt.connected) throw new DOMException('GATT Server is disconnected.', 'NetworkError');
    await this.device.fingerbot.write(new Uint8Array(bytes.buffer ? bytes : new Uint8Array(bytes)));
  }
}

class FakeGatt {
  constructor(device) {
    this.device = device;
    this.connected = false;
  }
  async connect() {
    await new Promise((r) => setTimeout(r, 30));
    this.connected = true;
    this.device.connects += 1;
    return this;
  }
  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.device.fingerbot.notify = null;
    this.device.emit('gattserverdisconnected', { target: this.device });
  }
  #service() {
    const d = this.device;
    const notify = new FakeCharacteristic(d.notifyUuid, d, { notify: true });
    const write = new FakeCharacteristic(d.writeUuid, d, { write: true, writeWithoutResponse: true });
    const chars = [notify, write];
    return {
      uuid: d.serviceUuid,
      getCharacteristic: async (cuuid) => {
        if (d.quirkyBridge) throw 'no such characteristic'; // bare string, like some bridges
        const c = chars.find((x) => sameUuid(x.uuid, cuuid));
        if (!c) throw new DOMException('No Characteristics matching UUID', 'NotFoundError');
        return c;
      },
      getCharacteristics: async () => chars,
    };
  }
  async getPrimaryService(uuid) {
    if (this.device.quirkyBridge) throw undefined; // exactly what Bluefy did: "failed: undefined"
    if (!sameUuid(uuid, this.device.serviceUuid)) throw new DOMException('No Services matching UUID', 'NotFoundError');
    return this.#service();
  }
  async getPrimaryServices() {
    return [this.#service()];
  }
}

class FakeBluetoothDevice extends Emitter {
  constructor(fingerbot) {
    super();
    this.id = 'fake-fingerbot-id';
    this.name = 'Fingerbot Plus';
    this.fingerbot = fingerbot;
    this.gatt = new FakeGatt(this);
    this.connects = 0;
    this.quirkyBridge = false;
    this.serviceUuid = SERVICE_UUID;
    this.notifyUuid = CHARACTERISTIC_NOTIFY;
    this.writeUuid = CHARACTERISTIC_WRITE;
  }
}

export function installFakeBluetooth(win, options = {}) {
  const fingerbot = new FakeFingerbot({ ...TEST_CREDENTIALS, ...options });
  const device = new FakeBluetoothDevice(fingerbot);
  device.quirkyBridge = !!options.quirkyBridge;
  if (options.quirkyBridge) {
    // A Bluefy-like bridge reports 16-bit UUIDs in short form.
    device.serviceUuid = 'A201';
    device.notifyUuid = '2B10';
    device.writeUuid = '2B11';
  }
  if (options.serviceUuid) device.serviceUuid = options.serviceUuid;
  if (options.notifyUuid) device.notifyUuid = options.notifyUuid;
  if (options.writeUuid) device.writeUuid = options.writeUuid;
  const state = { fingerbot, device, requestDeviceCalls: 0, getDevicesCalls: 0, remembered: options.remembered ?? false };
  const bluetooth = {
    async requestDevice(opts) {
      state.requestDeviceCalls += 1;
      state.lastRequestOptions = opts;
      state.remembered = true;
      return device;
    },
    async getDevices() {
      state.getDevicesCalls += 1;
      return state.remembered ? [device] : [];
    },
    async getAvailability() {
      return true;
    },
  };
  Object.defineProperty(win.navigator, 'bluetooth', { value: bluetooth, configurable: true });
  win.__fakeBluetooth = state;
  return state;
}

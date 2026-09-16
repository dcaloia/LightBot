// A stand-in for navigator.bluetooth so the page can be driven end to end in headless
// Chromium. One FakeFingerbot sits behind a fake BluetoothDevice.

import { FakeFingerbot, TEST_CREDENTIALS } from './fake-device.mjs';
import { SERVICE_UUID, CHARACTERISTIC_NOTIFY, CHARACTERISTIC_WRITE } from '../tuya-ble.js';

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
  constructor(uuid, device) {
    super();
    this.uuid = uuid;
    this.device = device;
    this.value = null;
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
  async getPrimaryService(uuid) {
    if (uuid !== SERVICE_UUID) throw new DOMException('No Services matching UUID', 'NotFoundError');
    return {
      getCharacteristic: async (cuuid) => {
        if (cuuid !== CHARACTERISTIC_NOTIFY && cuuid !== CHARACTERISTIC_WRITE) {
          throw new DOMException('No Characteristics matching UUID', 'NotFoundError');
        }
        return new FakeCharacteristic(cuuid, this.device);
      },
    };
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
  }
}

export function installFakeBluetooth(win, options = {}) {
  const fingerbot = new FakeFingerbot({ ...TEST_CREDENTIALS, ...options });
  const device = new FakeBluetoothDevice(fingerbot);
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

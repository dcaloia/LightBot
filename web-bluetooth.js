// Web Bluetooth transport for the Tuya BLE session.
//
// Works in Chrome/Edge on Android, Chrome on desktop, and the Bluefy or WebBLE apps
// on iPhone (Safari itself has no Web Bluetooth). GitHub Pages is HTTPS, which the
// API requires.

import { SERVICE_UUID, CHARACTERISTIC_NOTIFY, CHARACTERISTIC_WRITE } from './tuya-ble.js';

const STORAGE_KEY = 'fingerbot.bluetoothDeviceId';

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
      this.log(`getDevices: ${err.message}`);
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
    try {
      this.server = await Promise.race([gatt.connect(), timeout]);
      const service = await Promise.race([this.server.getPrimaryService(SERVICE_UUID), timeout]);
      this.notifyChar = await service.getCharacteristic(CHARACTERISTIC_NOTIFY);
      this.writeChar = await service.getCharacteristic(CHARACTERISTIC_WRITE);
      this.notifyChar.addEventListener('characteristicvaluechanged', this.#handleNotification);
      await Promise.race([this.notifyChar.startNotifications(), timeout]);
      this.log('Connected');
    } catch (err) {
      try {
        gatt.disconnect();
      } catch {
        /* ignore */
      }
      throw err;
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
    if (this.writeChar.writeValueWithoutResponse) {
      await this.writeChar.writeValueWithoutResponse(bytes);
    } else {
      await this.writeChar.writeValue(bytes);
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

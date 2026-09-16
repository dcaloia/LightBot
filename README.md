# Fingerbot

A phone web page that presses a **Tuya Fingerbot Plus** over Bluetooth. No server,
no cloud, no app: it is a static site on GitHub Pages, and the phone talks to the
Fingerbot directly with **Web Bluetooth**.

Two things it does:

- **Press**: one single press.
- **One-hour cycle**: a press right away, then one every 12 minutes, for an hour
  (five presses: at 0, 12, 24, 36 and 48 minutes). Length and interval are
  adjustable in Settings.

## Using it

1. Open the page on your phone: **https://dcaloia.github.io/fingerbot/**
   - **Android**: Chrome (or Edge). Web Bluetooth is built in.
   - **iPhone**: Safari has no Web Bluetooth. Install the free **Bluefy** browser
     from the App Store and open the page in it. Add it to the home screen from
     there if you like.
2. Tap the gear and enter the three keys for your Fingerbot (see below), or open a
   one-tap setup link of the form
   `https://dcaloia.github.io/fingerbot/#id=DEVICE_ID&uuid=UUID&key=LOCAL_KEY`.
   The keys are saved in that browser only; the part after `#` never leaves the phone.
3. Tap **Pair Fingerbot** (or just **Press**). The browser shows nearby Bluetooth
   devices; pick the Fingerbot. Chrome remembers it for next time.
4. **Press** to press once. **Start** to run the one-hour cycle.

During a cycle keep the page open and in the foreground: the phone is the thing
doing the pressing, and browsers pause pages that are not visible. The page asks the
phone to keep the screen on while a cycle runs. If it does get interrupted, reopening
the page resumes the cycle where it left off, and a long gap produces one catch-up
press rather than a burst.

The phone has to be within Bluetooth range of the Fingerbot (a few metres, same
room is safest).

### The three keys

The Fingerbot only accepts commands from a phone that proves it knows the device's
secret. The values come from the Tuya IoT platform (the same account the Smart Life
app uses):

| Key | Where |
|-----|-------|
| Device id | Tuya IoT platform, Cloud, Development, your project, Devices tab, or the `id` field of the device JSON |
| UUID | `uuid` field of the "Query Device Details" API response (`GET /v2.0/cloud/thing/{device_id}`) |
| Local key | `local_key` field of the same response |

Only the first six characters of the local key are used by the Bluetooth protocol,
but paste the whole thing.

## How it works

`tuya-ble.js` speaks Tuya's BLE protocol (the connected GATT one, version 3):
a device-info request encrypted with `md5(localKey[:6])`, a pairing request
(uuid + key + device id) encrypted with the session key derived from the device's
random nonce, then datapoint writes. AES-CBC comes from WebCrypto (with a small
trick to disable its PKCS#7 padding), MD5 from `md5.js`.

`fingerbot.js` turns that into one `press()`: connect, pair, make sure the device is
in **click** mode (datapoint 8 = 0), set the switch datapoint (2) to true, wait for
the echo, disconnect. Disconnecting after every press keeps the Fingerbot's battery
out of a permanent connection.

`cycle.js` is the scheduler; `web-bluetooth.js` is the GATT transport; `app.js` is
the page.

## Development

Plain ES modules, no build step. Serve the folder and open `index.html`.

```bash
npm test                      # protocol + scheduler tests (Node 22)
npm run serve &               # static server on 127.0.0.1:8765
npm install playwright        # once; then
npm run test:e2e              # drives the page in headless Chromium with a fake Fingerbot
```

The protocol tests check the JavaScript byte-for-byte against fixtures produced by
the original Python implementation (`tools/gen_fixtures.py`, needs `pip install
tuya-ble pycryptodome`). The end-to-end test swaps `navigator.bluetooth` for a fake
that behaves like a Fingerbot Plus (`test/fake-device.mjs`).

Pushing to `main` runs the tests and deploys to GitHub Pages
(`.github/workflows/pages.yml`).

## Credits

The protocol is a port of the MIT-licensed [tuya-ble](https://github.com/PlusPlus-ua/tuya_ble)
Python library and the Fingerbot datapoint map from
[ha_tuya_ble](https://github.com/PlusPlus-ua/ha_tuya_ble), both by Oleksandr Plias.

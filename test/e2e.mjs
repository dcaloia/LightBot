// Drives the real page in headless Chromium with navigator.bluetooth replaced by
// test/fake-bluetooth.mjs. Run: node test/e2e.mjs  (needs playwright and a static
// server on PORT, default 8765; see package.json "test:e2e").
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { TEST_CREDENTIALS } from './fake-device.mjs';

const PORT = process.env.PORT || 8765;
const BASE = `http://127.0.0.1:${PORT}/`;

const initScript = `
  if (!location.protocol.startsWith('http')) return; // skip the initial about:blank document
  const pending = import(new URL('/test/fake-bluetooth.mjs', location.href).href).then((m) => m.installFakeBluetooth(window, window.__fakeOptions || {}));
  // navigator.bluetooth must exist synchronously for the support check; the real
  // object arrives before any user action.
  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    value: {
      requestDevice: (...a) => pending.then(() => navigator.bluetooth.requestDevice(...a)),
      getDevices: (...a) => pending.then(() => navigator.bluetooth.getDevices(...a)),
      getAvailability: async () => true,
    },
  });
  window.__fakeReady = pending;
`;

async function newPage(browser, { storage = null, options = {} } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(`window.__fakeOptions = ${JSON.stringify(options)};`);
  await context.addInitScript(initScript);
  if (storage) {
    await context.addInitScript((items) => {
      for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
    }, storage);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return { context, page, errors };
}

const fakeState = (page) =>
  page.evaluate(async () => {
    await window.__fakeReady;
    const s = window.__fakeBluetooth;
    return { presses: s.fingerbot.presses.length, mode: s.fingerbot.mode, requestDeviceCalls: s.requestDeviceCalls, connects: s.device.connects, connected: s.device.gatt.connected };
  });

async function run() {
  const browser = await chromium.launch();
  try {
    // 1. Setup link, manual press, pairing through the chooser.
    {
      const { page, errors, context } = await newPage(browser);
      const link = `${BASE}#id=${TEST_CREDENTIALS.deviceId}&uuid=${TEST_CREDENTIALS.uuid}&key=${encodeURIComponent(TEST_CREDENTIALS.localKey)}`;
      await page.goto(link);
      await page.waitForFunction(() => window.__fakeBluetooth);
      assert.equal(await page.evaluate(() => location.hash), '', 'hash cleared after reading the keys');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('fingerbot.credentials')).uuid), TEST_CREDENTIALS.uuid);
      assert.equal(await page.locator('#setup-notice').isHidden(), true);
      assert.equal(await page.locator('#support-warning').isHidden(), true);
      assert.equal(await page.locator('#press-button').isEnabled(), true);

      await page.click('#press-button');
      await page.waitForFunction(() => document.querySelector('#status-line').textContent.startsWith('Pressed at'), null, { timeout: 15000 });
      let s = await fakeState(page);
      assert.equal(s.presses, 1, 'one press reached the fake device');
      assert.equal(s.requestDeviceCalls, 1, 'chooser shown once');
      assert.equal(s.connected, false, 'link dropped after the press');
      assert.match(await page.locator('#device-line').textContent(), /Fingerbot Plus/);

      // Second press reuses the device without the chooser.
      await page.click('#press-button');
      await page.waitForFunction(() => window.__fakeBluetooth.fingerbot.presses.length === 2, null, { timeout: 15000 });
      s = await fakeState(page);
      assert.equal(s.requestDeviceCalls, 1);
      assert.deepEqual(errors, []);
      await context.close();
      console.log('ok - setup link, manual press, pairing');
    }

    // 1b. The setup-code form after "?" also works, and the query string is cleared.
    {
      const { page, errors, context } = await newPage(browser);
      const code = Buffer.from(JSON.stringify({ id: TEST_CREDENTIALS.deviceId, uuid: TEST_CREDENTIALS.uuid, key: TEST_CREDENTIALS.localKey })).toString('base64url');
      await page.goto(`${BASE}?s=${code}`);
      await page.waitForFunction(() => window.__fakeBluetooth);
      assert.equal(await page.evaluate(() => location.search + location.hash), '');
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('fingerbot.credentials')));
      assert.deepEqual({ deviceId: stored.deviceId, uuid: stored.uuid, localKey: stored.localKey }, TEST_CREDENTIALS);
      assert.equal(stored.source, 'link');
      assert.equal(await page.locator('#press-button').isEnabled(), true);
      // The page's own encoder produces the same code.
      const encoded = await page.evaluate(async (c) => (await import('/app.js')).encodeSetupCode(c), TEST_CREDENTIALS);
      assert.equal(encoded, code);
      assert.deepEqual(errors, []);
      await context.close();
      console.log('ok - setup code in the query string');
    }

    // 2. A short cycle: 0.06 min long, every 0.02 min -> presses at 0, 1.2 s, 2.4 s.
    {
      const storage = {
        'fingerbot.credentials': JSON.stringify(TEST_CREDENTIALS),
        'fingerbot.cycleSettings': JSON.stringify({ durationMinutes: 0.06, intervalMinutes: 0.02, pressAtStart: true }),
        'fingerbot.bluetoothDeviceId': 'fake-fingerbot-id',
      };
      const { page, errors, context } = await newPage(browser, { storage, options: { remembered: true, mode: 1 } });
      await page.goto(BASE);
      await page.waitForFunction(() => window.__fakeBluetooth);
      assert.match(await page.locator('#cycle-summary').textContent(), /every 0.02 minutes for 0.06 minutes/);
      await page.click('#cycle-button');
      assert.equal(await page.locator('#cycle-button').textContent(), 'Stop');
      await page.waitForFunction(() => document.querySelector('#cycle-countdown').textContent === 'Done', null, { timeout: 20000 });
      const s = await fakeState(page);
      assert.equal(s.presses, 3, 'three cycle presses');
      assert.equal(s.mode, 0, 'device switched to click mode');
      assert.equal(s.requestDeviceCalls, 0, 'remembered device, no chooser');
      assert.equal(await page.locator('#cycle-dots li.done').count(), 3);
      assert.match(await page.locator('#cycle-detail').textContent(), /3 of 3 presses succeeded/);
      assert.equal(await page.locator('#cycle-button').textContent(), 'Start');
      assert.deepEqual(errors, []);
      await context.close();
      console.log('ok - short cycle runs to completion');
    }

    // 3. Reload mid-cycle resumes it, and Stop ends it.
    {
      const storage = {
        'fingerbot.credentials': JSON.stringify(TEST_CREDENTIALS),
        'fingerbot.cycleSettings': JSON.stringify({ durationMinutes: 5, intervalMinutes: 1, pressAtStart: true }),
        'fingerbot.bluetoothDeviceId': 'fake-fingerbot-id',
      };
      const { page, errors, context } = await newPage(browser, { storage, options: { remembered: true } });
      await page.goto(BASE);
      await page.waitForFunction(() => window.__fakeBluetooth);
      await page.click('#cycle-button');
      await page.waitForFunction(() => /1 of 5 done/.test(document.querySelector('#cycle-detail').textContent), null, { timeout: 15000 });
      await page.reload();
      await page.waitForFunction(() => window.__fakeBluetooth);
      await page.waitForFunction(() => document.querySelector('#cycle-button').textContent === 'Stop');
      assert.match(await page.locator('#cycle-detail').textContent(), /1 of 5 done/);
      assert.match(await page.locator('#status-line').textContent(), /resumed/i);
      await page.click('#cycle-button');
      assert.equal(await page.locator('#cycle-button').textContent(), 'Start');
      assert.equal(await page.locator('#cycle-countdown').textContent(), 'Stopped');
      assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('fingerbot.cycle'))).running, false);
      assert.deepEqual(errors, []);
      await context.close();
      console.log('ok - reload resumes, stop ends');
    }

    // 4. Built-in keys. config.js is swapped for one carrying the test keys, so the
    //    scenario does not depend on what the real file holds.
    {
      const { page, errors, context } = await newPage(browser);
      let served = TEST_CREDENTIALS;
      await page.route('**/config.js', (route) =>
        route.fulfill({
          contentType: 'text/javascript',
          body: `export const DEFAULT_CREDENTIALS = ${JSON.stringify(served)};`,
        }),
      );
      await page.goto(BASE);
      await page.waitForFunction(() => window.__fakeBluetooth);
      assert.equal(await page.locator('#setup-notice').isHidden(), true, 'no setup notice with built-in keys');
      assert.equal(await page.locator('#press-button').isEnabled(), true);
      let saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fingerbot.credentials')));
      assert.equal(saved.source, 'default');
      assert.equal(saved.localKey, TEST_CREDENTIALS.localKey);
      await page.click('#press-button');
      await page.waitForFunction(() => window.__fakeBluetooth.fingerbot.presses.length === 1, null, { timeout: 15000 });

      // config.js changes (re-paired Fingerbot): the stored built-in copy is replaced.
      served = { ...TEST_CREDENTIALS, localKey: 'newkey0000000000' };
      await page.reload();
      await page.waitForFunction(() => window.__fakeBluetooth);
      saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fingerbot.credentials')));
      assert.equal(saved.localKey, 'newkey0000000000', 'new built-in keys replace stale built-in keys');

      // Keys typed in Settings stick across reloads even though config.js differs.
      await page.click('#settings-button');
      await page.fill('input[name=localKey]', TEST_CREDENTIALS.localKey);
      await page.click('#settings button[type=submit]');
      await page.reload();
      await page.waitForFunction(() => window.__fakeBluetooth);
      saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fingerbot.credentials')));
      assert.equal(saved.source, 'manual');
      assert.equal(saved.localKey, TEST_CREDENTIALS.localKey, 'manual keys are kept');

      // The "fill in the built-in keys" button restores config.js values in the form.
      await page.click('#settings-button');
      await page.click('#use-defaults');
      assert.equal(await page.inputValue('input[name=localKey]'), 'newkey0000000000');
      await page.click('#settings-cancel');
      assert.deepEqual(errors, []);
      await context.close();
      console.log('ok - built-in keys load by default; updates and manual keys behave');
    }

    // 4b. With config.js empty, a first visit shows the setup notice and Settings works.
    {
      const { page, errors, context } = await newPage(browser);
      await page.route('**/config.js', (route) =>
        route.fulfill({ contentType: 'text/javascript', body: "export const DEFAULT_CREDENTIALS = { deviceId: '', uuid: '', localKey: '' };" }),
      );
      await page.goto(BASE);
      await page.waitForFunction(() => window.__fakeBluetooth);
      assert.equal(await page.locator('#setup-notice').isVisible(), true);
      assert.equal(await page.locator('#press-button').isEnabled(), false);
      await page.click('#settings-button');
      assert.equal(await page.locator('#use-defaults').isHidden(), true, 'no built-in button without built-in keys');
      await page.fill('input[name=deviceId]', TEST_CREDENTIALS.deviceId);
      await page.fill('input[name=uuid]', TEST_CREDENTIALS.uuid);
      await page.fill('input[name=localKey]', TEST_CREDENTIALS.localKey);
      await page.click('#settings button[type=submit]');
      assert.equal(await page.locator('#setup-notice').isHidden(), true);
      await page.click('#press-button');
      await page.waitForFunction(() => window.__fakeBluetooth.fingerbot.presses.length === 1, null, { timeout: 15000 });
      assert.deepEqual(errors, []);
      await context.close();
      console.log('ok - settings dialog with empty config.js');
    }

    // 4c. A bridge that throws bare values and reports short UUIDs (Bluefy) still works.
    {
      const storage = {
        'fingerbot.credentials': JSON.stringify(TEST_CREDENTIALS),
        'fingerbot.bluetoothDeviceId': 'fake-fingerbot-id',
      };
      const { page, errors, context } = await newPage(browser, { storage, options: { remembered: true, quirkyBridge: true } });
      await page.goto(BASE);
      await page.waitForFunction(() => window.__fakeBluetooth);
      await page.click('#press-button');
      await page.waitForFunction(() => document.querySelector('#status-line').textContent.startsWith('Pressed at'), null, { timeout: 15000 });
      const s = await fakeState(page);
      assert.equal(s.presses, 1);
      const logText = await page.locator('#log').textContent();
      assert.match(logText, /getPrimaryService failed \(unknown error\); listing services/);
      assert.match(logText, /Services: A201/);
      assert.match(logText, /Connected, notifications on/);
      assert.deepEqual(errors, []);
      await context.close();
      console.log('ok - short-UUID bridge with bare errors');
    }

    // 5. Wrong local key: the press fails visibly, nothing gets pressed.
    {
      const storage = {
        'fingerbot.credentials': JSON.stringify({ ...TEST_CREDENTIALS, localKey: 'nope00nope' }),
        'fingerbot.bluetoothDeviceId': 'fake-fingerbot-id',
      };
      const { page, context } = await newPage(browser, { storage, options: { remembered: true } });
      await page.goto(BASE);
      await page.waitForFunction(() => window.__fakeBluetooth);
      await page.click('#press-button');
      await page.waitForFunction(() => document.querySelector('#status-line').classList.contains('error'), null, { timeout: 60000 });
      const s = await fakeState(page);
      assert.equal(s.presses, 0);
      await context.close();
      console.log('ok - wrong key fails visibly');
    }
  } finally {
    await browser.close();
  }
  console.log('e2e passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

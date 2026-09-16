// The page: wires the Press button and the one-hour cycle to the Fingerbot over Web
// Bluetooth. Keys live in this browser's localStorage only.

import { WebBluetoothTransport, NoDeviceError } from './web-bluetooth.js';
import { Fingerbot } from './fingerbot.js';
import { CycleRunner } from './cycle.js';
import { DEFAULT_CREDENTIALS } from './config.js';

const CREDS_KEY = 'fingerbot.credentials';
const CYCLE_SETTINGS_KEY = 'fingerbot.cycleSettings';
const DEFAULT_CYCLE = { durationMinutes: 60, intervalMinutes: 12, pressAtStart: true };

const $ = (id) => document.getElementById(id);
const el = {
  press: $('press-button'),
  pressSub: $('press-sub'),
  cycleButton: $('cycle-button'),
  cycleSummary: $('cycle-summary'),
  cycleStatus: $('cycle-status'),
  cycleCountdown: $('cycle-countdown'),
  cycleDetail: $('cycle-detail'),
  cycleDots: $('cycle-dots'),
  pair: $('pair-button'),
  deviceLine: $('device-line'),
  status: $('status-line'),
  log: $('log'),
  supportWarning: $('support-warning'),
  setupNotice: $('setup-notice'),
  settings: $('settings'),
  settingsForm: $('settings-form'),
  settingsButton: $('settings-button'),
  settingsCancel: $('settings-cancel'),
  forgetDevice: $('forget-device'),
  useDefaults: $('use-defaults'),
};

// ---------------------------------------------------------------------------
// Log + status

const logLines = [];
function log(message) {
  const stamp = new Date().toLocaleTimeString([], { hour12: false });
  logLines.push(`${stamp}  ${message}`);
  if (logLines.length > 300) logLines.shift();
  el.log.textContent = logLines.join('\n');
  el.log.scrollTop = el.log.scrollHeight;
}

function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = `status ${kind}`.trim();
}

// ---------------------------------------------------------------------------
// Storage

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    log('Could not save to this browser (private mode?)');
  }
}

// A one-tap setup link can carry the keys in the URL. Two forms are accepted, after
// either "#" (never leaves the phone) or "?" (survives address bars that mangle "#"):
//   ...#id=DEVICE_ID&uuid=UUID&key=LOCAL_KEY
//   ...?s=SETUP_CODE   where the code is base64url of {"id","uuid","key"}, so it is
//                      only letters, digits, "-" and "_", and no browser rewrites it.
function decodeBase64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeSetupCode({ deviceId, uuid, localKey }) {
  const bytes = new TextEncoder().encode(JSON.stringify({ id: deviceId, uuid, key: localKey }));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function credentialsFromParams(params) {
  const code = params.get('s');
  if (code) {
    try {
      const o = JSON.parse(decodeBase64Url(code));
      return { deviceId: o.id, uuid: o.uuid, localKey: o.key };
    } catch {
      return null;
    }
  }
  const deviceId = params.get('id');
  const uuid = params.get('uuid');
  const localKey = params.get('key');
  return deviceId && uuid && localKey ? { deviceId, uuid, localKey } : null;
}

function credentialsFromUrl() {
  for (const raw of [location.hash.replace(/^#/, ''), location.search.replace(/^\?/, '')]) {
    if (!raw) continue;
    const c = credentialsFromParams(new URLSearchParams(raw));
    if (validCredentials(c)) {
      history.replaceState(null, '', location.pathname);
      return c;
    }
  }
  return null;
}

function validCredentials(c) {
  return !!(c && c.deviceId && c.uuid && c.localKey && c.localKey.length >= 6);
}

function sameCredentials(a, b) {
  return !!a && !!b && a.deviceId === b.deviceId && a.uuid === b.uuid && a.localKey === b.localKey;
}

// Where the keys came from decides what wins later: keys typed in Settings or taken
// from a setup link stick; keys copied from config.js are replaced whenever config.js
// changes, so a re-paired Fingerbot only needs one push.
function loadCredentials() {
  const fromUrl = credentialsFromUrl();
  if (fromUrl) {
    writeJson(CREDS_KEY, { ...fromUrl, source: 'link' });
    log('Keys loaded from the setup link');
    return fromUrl;
  }
  const saved = readJson(CREDS_KEY);
  if (validCredentials(saved) && (saved.source !== 'default' || sameCredentials(saved, DEFAULT_CREDENTIALS))) {
    return saved;
  }
  if (validCredentials(DEFAULT_CREDENTIALS)) {
    writeJson(CREDS_KEY, { ...DEFAULT_CREDENTIALS, source: 'default' });
    log(saved ? 'Built-in keys changed; using the new ones' : 'Using the built-in keys');
    return { ...DEFAULT_CREDENTIALS };
  }
  return null;
}

// ---------------------------------------------------------------------------
// State

let credentials = loadCredentials();
let cycleSettings = { ...DEFAULT_CYCLE, ...(readJson(CYCLE_SETTINGS_KEY) || {}) };

const supported = WebBluetoothTransport.isSupported();
const transport = new WebBluetoothTransport({ log });
let bot = validCredentials(credentials) ? new Fingerbot({ transport, credentials, log }) : null;
let busy = false;
let wakeLock = null;

const cycle = new CycleRunner({
  press: () => doPress('cycle'),
  ...cycleSettings,
  storage: localStorage,
  onChange: () => render(),
  log,
});

// ---------------------------------------------------------------------------
// Actions

async function ensureDevice({ mayPrompt }) {
  if (transport.device) return;
  await transport.restoreDevice();
  if (transport.device) return;
  if (!mayPrompt) throw new NoDeviceError();
  await pickDevice();
}

async function pickDevice() {
  try {
    await transport.pickDevice();
  } catch (err) {
    if (err.name === 'NotFoundError') {
      // The chooser was cancelled or showed nothing. Offer the unfiltered list, which
      // helps when the Fingerbot's advertisement does not include its service id.
      if (window.confirm('No Fingerbot found. Show every nearby Bluetooth device instead?')) {
        await transport.pickDevice({ anyDevice: true });
      } else {
        throw new NoDeviceError();
      }
    } else {
      throw err;
    }
  }
  render();
}

async function doPress(source) {
  if (!supported) throw new Error('This browser has no Web Bluetooth. Use Chrome on Android or the Bluefy app on iPhone.');
  if (!bot) throw new Error('Enter the device keys in Settings first.');
  await ensureDevice({ mayPrompt: source === 'manual' });
  busy = true;
  render();
  setStatus(source === 'cycle' ? 'Cycle press…' : 'Pressing…');
  try {
    const result = await bot.press();
    setStatus(`Pressed at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`, 'ok');
    return result;
  } catch (err) {
    setStatus(err.message, 'error');
    throw err;
  } finally {
    busy = false;
    render();
  }
}

async function keepAwake(on) {
  if (!('wakeLock' in navigator)) return;
  try {
    if (on && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
      log('Screen will stay on during the cycle');
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (err) {
    log(`Wake lock: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Rendering

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatCountdown(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function formatClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function render() {
  const ready = supported && !!bot;
  el.supportWarning.hidden = supported;
  el.setupNotice.hidden = !!bot;

  el.press.disabled = !ready || busy;
  el.press.classList.toggle('busy', busy);
  el.pressSub.textContent = busy ? 'working…' : 'single press';

  el.deviceLine.textContent = transport.deviceName ? `Paired with ${transport.deviceName}` : 'No Fingerbot chosen yet';
  el.pair.textContent = transport.deviceName ? 'Change device' : 'Pair Fingerbot';
  el.pair.disabled = !supported;

  const s = cycle.state;
  const every = cycleSettings.intervalMinutes;
  const length = cycleSettings.durationMinutes;
  el.cycleSummary.textContent = `Presses every ${every} minute${every === 1 ? '' : 's'} for ${length} minute${length === 1 ? '' : 's'}`;
  el.cycleButton.textContent = s.running ? 'Stop' : 'Start';
  el.cycleButton.classList.toggle('stop', s.running);
  el.cycleButton.disabled = !ready;

  const showStatus = s.running || (s.finishedReason && s.startedAt !== null);
  el.cycleStatus.hidden = !showStatus;
  if (showStatus) {
    if (s.running) {
      if (s.pressing) {
        el.cycleCountdown.textContent = 'Pressing';
      } else if (s.nextAt !== null) {
        el.cycleCountdown.textContent = formatCountdown(s.nextAt - Date.now());
      }
      const next = s.nextAt !== null ? `next at ${formatClock(s.nextAt)} · ` : '';
      el.cycleDetail.textContent = `${next}${s.completed} of ${s.total} done · ends ${formatClock(s.endsAt)}`;
    } else {
      const ok = s.results.filter((r) => r.ok).length;
      el.cycleCountdown.textContent = s.finishedReason === 'finished' ? 'Done' : 'Stopped';
      el.cycleDetail.textContent = `${ok} of ${s.total} presses succeeded`;
    }
    el.cycleDots.replaceChildren(
      ...Array.from({ length: s.total }, (_, i) => {
        const li = document.createElement('li');
        const r = s.results[i];
        if (r) li.className = r.skipped ? 'skipped' : r.ok ? 'done' : 'failed';
        else if (s.running && i === s.completed) li.className = 'next';
        li.title = `Press ${i + 1}`;
        return li;
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Settings dialog

function openSettings() {
  const f = el.settingsForm;
  f.deviceId.value = credentials?.deviceId || '';
  f.uuid.value = credentials?.uuid || '';
  f.localKey.value = credentials?.localKey || '';
  f.durationMinutes.value = cycleSettings.durationMinutes;
  f.intervalMinutes.value = cycleSettings.intervalMinutes;
  f.pressAtStart.checked = cycleSettings.pressAtStart;
  el.settings.showModal();
}

el.settingsForm.addEventListener('submit', (event) => {
  const f = el.settingsForm;
  const next = {
    deviceId: f.deviceId.value.trim(),
    uuid: f.uuid.value.trim(),
    localKey: f.localKey.value.trim(),
  };
  if (!validCredentials(next)) {
    event.preventDefault();
    setStatus('All three keys are needed', 'error');
    return;
  }
  credentials = next;
  writeJson(CREDS_KEY, { ...credentials, source: 'manual' });
  bot = new Fingerbot({ transport, credentials, log });

  const duration = Number(f.durationMinutes.value);
  const interval = Number(f.intervalMinutes.value);
  if (duration > 0 && interval > 0) {
    cycleSettings = { durationMinutes: duration, intervalMinutes: interval, pressAtStart: f.pressAtStart.checked };
    writeJson(CYCLE_SETTINGS_KEY, cycleSettings);
    if (!cycle.running) {
      cycle.durationMinutes = duration;
      cycle.intervalMinutes = interval;
      cycle.pressAtStart = cycleSettings.pressAtStart;
    }
  }
  setStatus('Settings saved', 'ok');
  log('Settings saved');
  render();
});

el.settingsButton.addEventListener('click', openSettings);
el.useDefaults.hidden = !validCredentials(DEFAULT_CREDENTIALS);
el.useDefaults.addEventListener('click', () => {
  const f = el.settingsForm;
  f.deviceId.value = DEFAULT_CREDENTIALS.deviceId;
  f.uuid.value = DEFAULT_CREDENTIALS.uuid;
  f.localKey.value = DEFAULT_CREDENTIALS.localKey;
});
el.settingsCancel.addEventListener('click', () => el.settings.close());
el.forgetDevice.addEventListener('click', () => {
  transport.forgetDevice();
  log('Forgot the Bluetooth device');
  render();
});

// ---------------------------------------------------------------------------
// Buttons

el.press.addEventListener('click', () => {
  doPress('manual').catch((err) => log(`Press failed: ${err.message}`));
});

el.pair.addEventListener('click', () => {
  pickDevice().then(
    () => setStatus(`Paired with ${transport.deviceName}`, 'ok'),
    (err) => {
      setStatus(err.message, 'error');
      log(`Pairing: ${err.message}`);
    },
  );
});

el.cycleButton.addEventListener('click', async () => {
  if (cycle.running) {
    cycle.stop();
    await keepAwake(false);
    setStatus('Cycle stopped');
    return;
  }
  try {
    await ensureDevice({ mayPrompt: true });
  } catch (err) {
    setStatus(err.message, 'error');
    return;
  }
  cycle.durationMinutes = cycleSettings.durationMinutes;
  cycle.intervalMinutes = cycleSettings.intervalMinutes;
  cycle.pressAtStart = cycleSettings.pressAtStart;
  cycle.start();
  await keepAwake(true);
  setStatus('Cycle running. Keep this page open.');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    cycle.poke();
    if (cycle.running) keepAwake(true);
  }
  render();
});

setInterval(() => {
  if (cycle.running) render();
}, 1000);

// ---------------------------------------------------------------------------
// Start-up

(async () => {
  if (!supported) log('Web Bluetooth is not available in this browser');
  if (!bot) log('No device keys yet; open Settings');
  if (supported) await transport.restoreDevice();
  if (cycle.resume()) {
    setStatus('Cycle resumed. Keep this page open.');
    keepAwake(true);
  }
  render();
})();

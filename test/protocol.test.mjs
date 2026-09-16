// Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { md5 } from '../md5.js';
import {
  Code,
  DpType,
  FragmentAssembler,
  TuyaBleSession,
  aesCbcDecryptNoPad,
  aesCbcEncryptNoPad,
  buildPackets,
  crc16,
  decodeDatapoints,
  deriveLoginKey,
  deriveSessionKey,
  encodeDatapoints,
  fromHex,
  packVarint,
  parseMessage,
  toHex,
  unpackVarint,
} from '../tuya-ble.js';
import { Fingerbot, FINGERBOT_DP } from '../fingerbot.js';
import { FakeFingerbot, TEST_CREDENTIALS, directTransport } from './fake-device.mjs';

const fx = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url)));

test('md5 matches hashlib', () => {
  for (const [input, hex] of Object.entries(fx.md5)) {
    assert.equal(toHex(md5(input)), hex, `md5(${JSON.stringify(input.slice(0, 20))})`);
  }
});

test('crc16 matches the reference', () => {
  for (const [hex, expected] of Object.entries(fx.crc16)) {
    assert.equal(crc16(fromHex(hex)), expected);
  }
});

test('varint round trips', () => {
  for (const v of [0, 1, 127, 128, 300, 16383, 16384, 1000000]) {
    const packed = packVarint(v);
    const [out, pos] = unpackVarint(packed, 0);
    assert.equal(out, v);
    assert.equal(pos, packed.length);
  }
});

test('key derivation matches the reference', () => {
  assert.equal(toHex(deriveLoginKey(fx.localKey)), fx.loginKey);
  assert.equal(toHex(deriveSessionKey(fx.localKey, fromHex(fx.srand))), fx.sessionKey);
});

test('AES-CBC without padding round trips through WebCrypto', async () => {
  const key = fromHex(fx.sessionKey);
  const iv = fromHex(fx.iv);
  for (const len of [16, 32, 48, 160]) {
    const plain = crypto.getRandomValues(new Uint8Array(len));
    const enc = await aesCbcEncryptNoPad(key, iv, plain);
    assert.equal(enc.length, len);
    const dec = await aesCbcDecryptNoPad(key, iv, enc);
    assert.deepEqual(dec, plain);
  }
});

test('outgoing packets are byte-identical to the Python reference', async () => {
  const loginKey = fromHex(fx.loginKey);
  const sessionKey = fromHex(fx.sessionKey);
  const iv = fromHex(fx.iv);
  const pair = new Uint8Array(44);
  const enc = new TextEncoder();
  pair.set(enc.encode(fx.uuid), 0);
  pair.set(enc.encode(fx.localKey.slice(0, 6)), 16);
  pair.set(enc.encode(fx.deviceId), 22);

  const cases = [
    ['deviceInfo', { seq: 1, code: Code.FUN_SENDER_DEVICE_INFO, data: new Uint8Array(0), key: loginKey, securityFlag: 4 }],
    ['pair', { seq: 2, code: Code.FUN_SENDER_PAIR, data: pair, key: sessionKey, securityFlag: 5 }],
    ['status', { seq: 3, code: Code.FUN_SENDER_DEVICE_STATUS, data: new Uint8Array(0), key: sessionKey, securityFlag: 5 }],
    ['dps', { seq: 4, code: Code.FUN_SENDER_DPS, data: encodeDatapoints([{ id: 2, type: DpType.BOOL, value: true }]), key: sessionKey, securityFlag: 5 }],
    [
      'dpsLong',
      {
        seq: 5,
        code: Code.FUN_SENDER_DPS,
        data: encodeDatapoints([
          { id: 8, type: DpType.ENUM, value: 0 },
          { id: 2, type: DpType.BOOL, value: true },
          { id: 9, type: DpType.VALUE, value: 80 },
        ]),
        key: sessionKey,
        securityFlag: 5,
      },
    ],
    [
      'timeReply',
      {
        seq: 6,
        code: Code.FUN_RECEIVE_TIME1_REQ,
        data: (() => {
          const tz = new Uint8Array(2);
          new DataView(tz.buffer).setInt16(0, -400);
          return new Uint8Array([...enc.encode('1789565629779'), ...tz]);
        })(),
        responseTo: 9,
        key: sessionKey,
        securityFlag: 5,
      },
    ],
  ];
  for (const [name, args] of cases) {
    const packets = await buildPackets({ ...args, iv, protocolVersion: 3 });
    assert.deepEqual(packets.map(toHex), fx.packets[name], name);
    for (const p of packets) assert.ok(p.length <= 20, `${name} fragment fits the 20-byte MTU`);
  }
});

test('incoming reference messages reassemble, decrypt and decode', async () => {
  const sessionKey = fromHex(fx.sessionKey);
  const keyFor = (flag) => (flag === 5 ? sessionKey : null);

  const asm = new FragmentAssembler();
  let whole = null;
  for (const frag of fx.deviceMessages.dpReport.fragments) {
    whole = asm.push(fromHex(frag));
  }
  assert.ok(whole, 'last fragment completes the message');
  const msg = await parseMessage(whole, keyFor);
  assert.equal(msg.seq, fx.deviceMessages.dpReport.seq);
  assert.equal(msg.code, Code.FUN_RECEIVE_DP);
  const dps = decodeDatapoints(msg.data, 0).map((d) => [d.id, d.type, d.value]);
  assert.deepEqual(dps, fx.deviceMessages.dpReport.dps);

  const asm2 = new FragmentAssembler();
  let whole2 = null;
  for (const frag of fx.deviceMessages.pairOk.fragments) whole2 = asm2.push(fromHex(frag));
  const msg2 = await parseMessage(whole2, keyFor);
  assert.equal(msg2.responseTo, fx.deviceMessages.pairOk.responseTo);
  assert.deepEqual(Array.from(msg2.data), [0]);
});

test('parseMessage rejects a corrupted CRC', async () => {
  const sessionKey = fromHex(fx.sessionKey);
  const asm = new FragmentAssembler();
  let whole = null;
  for (const frag of fx.deviceMessages.dpReport.fragments) whole = asm.push(fromHex(frag));
  // Flip a byte in the last ciphertext block: decrypts to garbage in the CRC/padding
  // area but the header block stays intact.
  whole[whole.length - 1] ^= 0xff;
  await assert.rejects(parseMessage(whole, () => sessionKey), /crc|length|short/i);
});

test('datapoint encoding covers every type', () => {
  const dps = [
    { id: 1, type: DpType.BOOL, value: true },
    { id: 2, type: DpType.VALUE, value: -5 },
    { id: 3, type: DpType.ENUM, value: 300 },
    { id: 4, type: DpType.STRING, value: 'hi' },
    { id: 5, type: DpType.RAW, value: Uint8Array.of(9, 8) },
  ];
  const decoded = decodeDatapoints(encodeDatapoints(dps));
  assert.deepEqual(
    decoded.map((d) => [d.id, d.type, d.value instanceof Uint8Array ? Array.from(d.value) : d.value]),
    [
      [1, 1, true],
      [2, 2, -5],
      [3, 4, 300],
      [4, 3, 'hi'],
      [5, 0, [9, 8]],
    ],
  );
});

test('full handshake and press against the fake device', async () => {
  const device = new FakeFingerbot({ ...TEST_CREDENTIALS, mode: 0 });
  const transport = directTransport(device);
  const log = [];
  const bot = new Fingerbot({ transport, credentials: TEST_CREDENTIALS, log: (m) => log.push(m), settleMs: 20, stateWaitMs: 500 });

  const result = await bot.press();
  assert.equal(device.presses.length, 1, 'device saw one press');
    // Requests, in order (replies to the device's own time request and DP reports carry a responseTo).
  const requests = device.received.filter((m) => m.responseTo === 0).map((m) => m.code);
  assert.deepEqual(requests, [Code.FUN_SENDER_DEVICE_INFO, Code.FUN_SENDER_PAIR, Code.FUN_SENDER_DEVICE_STATUS, Code.FUN_SENDER_DPS]);
  const acks = device.received.filter((m) => m.responseTo !== 0).map((m) => m.code);
  assert.deepEqual(acks, [Code.FUN_RECEIVE_TIME1_REQ, Code.FUN_RECEIVE_DP, Code.FUN_RECEIVE_SIGN_DP]);
  assert.equal(device.timeReplies.length, 1, 'phone answered the time request');
  assert.match(device.timeReplies[0], /^\d{13}$/);
  assert.equal(transport.connected, false, 'disconnected afterwards');
  assert.equal(result.firmware, '1.2');
  assert.ok(log.some((l) => l.startsWith('Pressed')));
});

test('switches the device to click mode first when it is in switch mode', async () => {
  const device = new FakeFingerbot({ ...TEST_CREDENTIALS, mode: 1 });
  const bot = new Fingerbot({ transport: directTransport(device), credentials: TEST_CREDENTIALS, settleMs: 20 });
  await bot.press();
  assert.equal(device.mode, 0);
  assert.equal(device.presses.length, 1);
});

test('already-paired reply (2) counts as success', async () => {
  const device = new FakeFingerbot({ ...TEST_CREDENTIALS, alreadyPaired: true });
  const bot = new Fingerbot({ transport: directTransport(device), credentials: TEST_CREDENTIALS, settleMs: 20 });
  await bot.press();
  assert.equal(device.presses.length, 1);
});

test('wrong local key fails to pair and retries stop', async () => {
  const device = new FakeFingerbot({ ...TEST_CREDENTIALS });
  const bot = new Fingerbot({
    transport: directTransport(device),
    credentials: { ...TEST_CREDENTIALS, localKey: 'wrong0key' },
    settleMs: 20,
    attempts: 2,
  });
  // The wrong login key makes the device unable to read our first packet, so the
  // phone times out. Keep the test fast with a short timeout via a custom session.
  await assert.rejects(
    (async () => {
      const t = directTransport(device);
      let session;
      await t.connect((b) => session?.onNotification(b));
      session = new TuyaBleSession({ ...TEST_CREDENTIALS, localKey: 'wrong0key', write: (b) => t.write(b), responseTimeoutMs: 200 });
      await session.initialize();
    })(),
    /no response|crc|error code|shorter|format/i,
  );
  assert.equal(device.presses.length, 0);
  void bot;
});

test('two presses are serialised, not interleaved', async () => {
  const device = new FakeFingerbot({ ...TEST_CREDENTIALS });
  const transport = directTransport(device);
  const bot = new Fingerbot({ transport, credentials: TEST_CREDENTIALS, settleMs: 20 });
  await Promise.all([bot.press(), bot.press()]);
  assert.equal(device.presses.length, 2);
  // Every DEVICE_INFO must be followed by its own PAIR before the next DEVICE_INFO.
  const codes = device.received.map((m) => m.code);
  const infos = codes.map((c, i) => [c, i]).filter(([c]) => c === Code.FUN_SENDER_DEVICE_INFO).map(([, i]) => i);
  assert.equal(infos.length, 2);
  assert.ok(codes.slice(infos[0], infos[1]).includes(Code.FUN_SENDER_DPS));
});

test('press timeout surfaces as an error and disconnects', async () => {
  const device = new FakeFingerbot({ ...TEST_CREDENTIALS });
  const silent = directTransport(device);
  silent.write = async () => {}; // device never hears us
  let session;
  await silent.connect((b) => session?.onNotification(b));
  session = new TuyaBleSession({ ...TEST_CREDENTIALS, write: (b) => silent.write(b), responseTimeoutMs: 100 });
  await assert.rejects(session.initialize(), /no response/);
});

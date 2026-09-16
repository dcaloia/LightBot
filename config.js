// Built-in keys, loaded automatically on first visit so the page is ready to pair.
// Fill in the three values from the Tuya IoT platform's device details. Leave them
// empty to make every phone enter its own keys (Settings or a setup link).
//
// After a factory reset of the Fingerbot, re-add it in Smart Life, fetch the new
// local_key (and id, if it changed), update these values and push: phones that never
// edited Settings pick the new keys up on their next visit. Keys entered by hand in
// Settings, or via a setup link, take precedence over these.
//
// This file is public along with the rest of the site. The local key is only useful
// to someone within Bluetooth range of the Fingerbot.
export const DEFAULT_CREDENTIALS = Object.freeze({
  deviceId: 'eb6bbevcvukoknve',
  uuid: 'tuyac7e02aa38d5a',
  localKey: "k[J)8V.Jj{-NBKjl",
});

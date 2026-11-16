// Disable the legacy whole-prompt hook while keeping Ponytail's specialist skills.
import { readFileSync, writeFileSync, copyFileSync, realpathSync } from 'node:fs';

const [, , settingsPath, source] = process.argv;
if (!settingsPath || !source) throw new Error('Usage: configure-pi.mjs <settings.json> <ponytail-source>');
const path = realpathSync(settingsPath);
const before = readFileSync(path, 'utf8');
let settings;
try {
  settings = JSON.parse(before);
} catch {
  throw new Error('Pi settings contain invalid JSON; the file was not changed');
}
if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
  throw new Error('Pi settings must be an object; the file was not changed');
}
if (!Array.isArray(settings.packages)) throw new Error('Missing packages in Pi settings');
let found = false;
let changed = false;
settings.packages = settings.packages.map((entry) => {
  if ((typeof entry === 'string' ? entry : entry?.source) !== source) return entry;
  found = true;
  if (typeof entry === 'object' && Array.isArray(entry.extensions) && entry.extensions.length === 0) return entry;
  changed = true;
  return { ...(typeof entry === 'object' ? entry : { source: entry }), extensions: [] };
});
if (!found) throw new Error('Ponytail is not registered; install it before configuring');
if (changed) {
  // Preserve a local snapshot; never print credentials or unrelated settings.
  copyFileSync(path, `${path}.before-pstack.${Date.now()}`);
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

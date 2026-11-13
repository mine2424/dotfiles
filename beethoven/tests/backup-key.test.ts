import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setupBackupKey,
  backupPublicKey,
  withBackupIdentity,
  withRecoveryCode,
  backupKeyStatus,
  backupKeyFiles,
  unwrapRecovery,
  unlockBackupKey,
  type KeychainTransport,
} from "../src/backup-key.js";
import { initializeStore } from "../src/store.js";
import { createBackup, restoreBackup } from "../src/backup.js";
function fixture(t: { after: (f: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "beethoven-key-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const items = new Map<string, Buffer>(),
    reads: Buffer[] = [];
  const transport: KeychainTransport = (op, account, data) => {
    if (op === "status")
      return Buffer.from(items.has(account) ? "present" : "missing");
    if (op === "save") {
      assert.equal(items.has(account), false);
      items.set(account, Buffer.from(data!));
      return Buffer.from("stored");
    }
    const value = Buffer.from(items.get(account)!);
    reads.push(value);
    return value;
  };
  t.after(() => {
    for (const b of items.values()) b.fill(0);
  });
  return {
    dir,
    config: join(dir, "config/config.json"),
    items,
    transport,
    reads,
  };
}
test("local keychain keeps the identity/code off disk, reuses them and zeroes read buffers", (t) => {
  const f = fixture(t),
    first = setupBackupKey(f.config, f.transport);
  assert.equal(first.privateKeyFileCreated, false);
  assert.equal(first.offDeviceVerified, false);
  assert.equal(first.recoveryVerifiedLocally, true);
  assert.equal(
    setupBackupKey(f.config, f.transport).fingerprint,
    first.fingerprint,
  );
  assert.equal(f.items.size, 2);
  assert.ok(f.reads.every((b) => b.every((v) => v === 0)));
  const files = backupKeyFiles(f.config),
    text =
      readFileSync(files.descriptor, "utf8") +
      readFileSync(files.recovery, "utf8");
  assert.ok(!text.includes("PRIVATE KEY"));
  assert.equal(existsSync(join(f.dir, "identity.pem")), false);
  withRecoveryCode(
    f.config,
    (code) => assert.ok(!text.includes(code.toString())),
    f.transport,
  );
  assert.ok(backupPublicKey(f.config).includes(Buffer.from("PUBLIC KEY")));
  assert.equal(backupKeyStatus(f.config).offDeviceVerified, false);
});
test("recovery code unlocks a separate device store; wrong code/tampering and missing local key cannot silently replace identity", (t) => {
  const f = fixture(t),
    second = fixture(t),
    first = setupBackupKey(f.config, f.transport),
    envelope = readFileSync(first.recoveryFile);
  let code = "";
  withRecoveryCode(
    f.config,
    (b) => {
      code = b.toString();
    },
    f.transport,
  );
  assert.throws(() =>
    unwrapRecovery(
      envelope,
      "BTV1-" + ["00000000", "00000000", "00000000", "00000000"].join("-"),
    ),
  );
  const d = JSON.parse(envelope.toString());
  d.tag = Buffer.alloc(16).toString("base64");
  assert.throws(() => unwrapRecovery(Buffer.from(JSON.stringify(d)), code));
  assert.equal(
    unlockBackupKey(second.config, envelope, code, second.transport)
      .fingerprint,
    first.fingerprint,
  );
  assert.deepEqual(backupPublicKey(second.config), backupPublicKey(f.config));
  assert.ok(second.reads.every((b) => b.every((v) => v === 0)));
  f.items.delete("primary");
  assert.throws(() => setupBackupKey(f.config, f.transport));
});
test("encrypted snapshot creates/restores with memory-only managed keys and never restores the plaintext recovery code", async (t) => {
  const f = fixture(t),
    key = setupBackupKey(f.config, f.transport),
    state = join(f.dir, "state"),
    out = join(f.dir, "snapshot.btb");
  await initializeStore(state);
  const created = await createBackup(
    state,
    f.config,
    backupPublicKey(f.config),
    out,
  );
  assert.equal(created.localCreated, true);
  const restored = withBackupIdentity(
    f.config,
    (identity) => restoreBackup(out, identity, join(f.dir, "restored")),
    f.transport,
  );
  assert.equal(restored.restoreVerified, true);
  let code = "";
  withRecoveryCode(
    f.config,
    (b) => {
      code = b.toString();
    },
    f.transport,
  );
  assert.ok(
    !readFileSync(
      join(restored.target, "config/backup-recovery.json"),
      "utf8",
    ).includes(code),
  );
  assert.equal(existsSync(join(restored.target, "config/auth")), false);
});

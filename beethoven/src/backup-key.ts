import { execFileSync } from "node:child_process";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateDirectory } from "./files.js";
import { hash, replaceFile } from "./workspace.js";
import { SetupError } from "./connections.js";
export type KeychainTransport = (
  operation: "status" | "save" | "read",
  account: string,
  data?: Buffer,
) => Buffer;
export const backupKeyFiles = (configFile: string) => ({
  descriptor: join(dirname(configFile), "backup-key.json"),
  recovery: join(dirname(configFile), "backup-recovery.json"),
});
export const keyFingerprint = (key: Buffer | string) =>
  hash(createPublicKey(key).export({ format: "der", type: "spki" }));
export function keychainTransport(configFile: string): KeychainTransport {
  return (operation, account, data) => {
    if (process.platform !== "darwin")
      throw new SetupError(
        "自動鍵管理はmacOS専用です。--identity/--recipientを使用してください。",
      );
    const source = fileURLToPath(
        new URL("../../scripts/backup-keychain.swift", import.meta.url),
      ),
      directory = join(dirname(configFile), "keychain-runtime");
    privateDirectory(directory);
    const executable = join(
      directory,
      "local-" + hash(readFileSync(source)).slice(0, 24),
    );
    if (!existsSync(executable)) {
      const temp = mkdtempSync(join(directory, "build-"));
      try {
        execFileSync(
          "/usr/bin/xcrun",
          ["swiftc", source, "-o", join(temp, "helper")],
          { stdio: "pipe", timeout: 60000 },
        );
        chmodSync(join(temp, "helper"), 0o700);
        renameSync(join(temp, "helper"), executable);
      } catch {
        throw new SetupError(
          "キーチェーンhelperを構築できません。Xcode Command Line Toolsを確認してください。",
        );
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    }
    const stat = lstatSync(executable);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new SetupError("キーチェーンhelperの所有者・権限が不正です。");
    try {
      return execFileSync(executable, [operation, account], {
        input: data,
        stdio: "pipe",
        timeout: 30000,
        maxBuffer: 16384,
      });
    } catch (error) {
      const status =
        String((error as { stderr?: Buffer }).stderr ?? "").match(
          /keychain_status:(-?\d+)/,
        )?.[1] ?? "unknown";
      throw new SetupError(
        "Macのキーチェーンへアクセスできません（OSStatus " +
          status +
          "）。ロック状態・OSのアクセス確認を確認してください。平文fileへは切り替えません。",
        "keychain_unavailable",
      );
    }
  };
}
export type Recovery = {
  version: 1;
  algorithm: "scrypt+AES-256-GCM";
  fingerprint: string;
  salt: string;
  iv: string;
  tag: string;
  data: string;
};
export function parseRecovery(bytes: Buffer): Recovery {
  try {
    if (bytes.length > 16384) throw Error();
    const d = JSON.parse(bytes.toString());
    if (
      d.version !== 1 ||
      d.algorithm !== "scrypt+AES-256-GCM" ||
      !/^[a-f0-9]{64}$/.test(d.fingerprint)
    )
      throw Error();
    for (const [key, size] of [
      ["salt", 16],
      ["iv", 12],
      ["tag", 16],
    ] as const)
      if (
        typeof d[key] !== "string" ||
        Buffer.from(d[key], "base64").length !== size
      )
        throw Error();
    if (
      typeof d.data !== "string" ||
      Buffer.from(d.data, "base64").length < 1024 ||
      Buffer.from(d.data, "base64").length > 8192
    )
      throw Error();
    return d;
  } catch {
    throw new SetupError("暗号化された復旧鍵の形式・容量が不正です。");
  }
}
function derived(code: string, salt: Buffer) {
  if (!/^BTV1-(?:[a-f0-9]{8}-){3}[a-f0-9]{8}$/.test(code))
    throw new SetupError("復旧コードの形式が不正です。");
  return scryptSync(code, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}
function wrap(key: Buffer, code: string): Recovery {
  const salt = randomBytes(16),
    iv = randomBytes(12),
    secret = derived(code, salt),
    fingerprint = keyFingerprint(key);
  try {
    const cipher = createCipheriv("aes-256-gcm", secret, iv);
    cipher.setAAD(Buffer.from("beethoven-recovery-v1:" + fingerprint));
    const data = Buffer.concat([cipher.update(key), cipher.final()]);
    return {
      version: 1,
      algorithm: "scrypt+AES-256-GCM",
      fingerprint,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  } finally {
    secret.fill(0);
  }
}
export function unwrapRecovery(bytes: Buffer, code: string): Buffer {
  const d = parseRecovery(bytes),
    secret = derived(code.trim(), Buffer.from(d.salt, "base64"));
  let key: Buffer | undefined;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      secret,
      Buffer.from(d.iv, "base64"),
    );
    decipher.setAAD(Buffer.from("beethoven-recovery-v1:" + d.fingerprint));
    decipher.setAuthTag(Buffer.from(d.tag, "base64"));
    key = Buffer.concat([
      decipher.update(Buffer.from(d.data, "base64")),
      decipher.final(),
    ]);
    if (keyFingerprint(key) !== d.fingerprint) throw Error();
    return key;
  } catch {
    key?.fill(0);
    throw new SetupError(
      "復旧コードまたは復旧鍵が一致しません。元の記録を保持して確認してください。",
    );
  } finally {
    secret.fill(0);
  }
}
function writePublic(file: string, data: unknown) {
  privateDirectory(dirname(file));
  replaceFile(
    file,
    JSON.stringify(data, null, 2) + "\n",
    existsSync(file) ? hash(readFileSync(file)) : null,
    0o600,
  );
}
function saveDescriptor(configFile: string, key: Buffer) {
  const file = backupKeyFiles(configFile).descriptor,
    fingerprint = keyFingerprint(key);
  if (
    existsSync(file) &&
    JSON.parse(readFileSync(file, "utf8")).fingerprint !== fingerprint
  )
    throw new SetupError(
      "既存backupと異なる鍵です。元の鍵を保持して確認してください。",
    );
  writePublic(file, {
    schemaVersion: 1,
    backend: "macos-keychain",
    fingerprint,
    publicKey: createPublicKey(key).export({ format: "pem", type: "spki" }),
  });
}
export function setupBackupKey(
  configFile: string,
  transport: KeychainTransport = keychainTransport(configFile),
) {
  const status = transport("status", "primary").toString().trim();
  let generated: Buffer | undefined;
  try {
    if (status === "missing") {
      if (existsSync(backupKeyFiles(configFile).descriptor))
        throw new SetupError(
          "保存済みの復旧鍵をbackup unlockで戻してください。新しい鍵で置換しません。",
        );
      const pair = generateKeyPairSync("rsa", {
        modulusLength: 3072,
        privateKeyEncoding: { type: "pkcs8", format: "der" },
        publicKeyEncoding: { type: "spki", format: "der" },
      });
      generated = Buffer.from(
        createPrivateKey({
          key: pair.privateKey,
          format: "der",
          type: "pkcs8",
        }).export({ format: "pem", type: "pkcs8" }),
      );
      pair.privateKey.fill(0);
      transport("save", "primary", generated);
    } else if (status !== "present")
      throw new SetupError("キーチェーンの応答が不正です。");
    const key = transport("read", "primary");
    try {
      if (generated && keyFingerprint(key) !== keyFingerprint(generated))
        throw new SetupError("保存鍵の照合に失敗しました。");
      saveDescriptor(configFile, key);
      const fingerprint = keyFingerprint(key),
        account = "recovery-code-" + fingerprint,
        file = backupKeyFiles(configFile).recovery;
      if (!existsSync(file)) {
        let code: Buffer;
        if (transport("status", account).toString().trim() === "present")
          code = transport("read", account);
        else {
          code = Buffer.from(
            "BTV1-" + randomBytes(16).toString("hex").match(/.{8}/g)!.join("-"),
          );
          transport("save", account, code);
        }
        try {
          writePublic(file, wrap(key, code.toString()));
        } finally {
          code.fill(0);
        }
      }
      const envelope = readFileSync(file),
        d = parseRecovery(envelope);
      if (d.fingerprint !== fingerprint)
        throw new SetupError("復旧鍵のfingerprintが一致しません。");
      const code = transport("read", account);
      try {
        const verified = unwrapRecovery(envelope, code.toString());
        try {
          if (keyFingerprint(verified) !== fingerprint)
            throw new SetupError("復旧鍵の検証に失敗しました。");
        } finally {
          verified.fill(0);
        }
      } finally {
        code.fill(0);
      }
      return {
        backend: "macos-keychain",
        fingerprint,
        stored: true,
        readBackVerified: true,
        recoveryVerifiedLocally: true,
        offDeviceVerified: false,
        privateKeyFileCreated: false,
        recoveryFile: file,
      };
    } finally {
      key.fill(0);
    }
  } finally {
    generated?.fill(0);
  }
}
export function backupKeyStatus(configFile: string) {
  const file = backupKeyFiles(configFile).descriptor;
  if (!existsSync(file)) return { configured: false, offDeviceVerified: false };
  const d = JSON.parse(readFileSync(file, "utf8"));
  return {
    configured: true,
    backend: d.backend,
    fingerprint: d.fingerprint,
    recoveryFilePresent: existsSync(backupKeyFiles(configFile).recovery),
    offDeviceVerified: false,
  };
}
export function backupPublicKey(configFile: string) {
  const d = JSON.parse(
    readFileSync(backupKeyFiles(configFile).descriptor, "utf8"),
  );
  if (
    d.backend !== "macos-keychain" ||
    keyFingerprint(d.publicKey) !== d.fingerprint
  )
    throw new SetupError("backup公開鍵が一致しません。");
  return Buffer.from(d.publicKey);
}
export function withBackupIdentity<T>(
  configFile: string,
  action: (key: Buffer) => T,
  transport: KeychainTransport = keychainTransport(configFile),
): T {
  const d = JSON.parse(
      readFileSync(backupKeyFiles(configFile).descriptor, "utf8"),
    ),
    key = transport("read", "primary");
  try {
    if (d.backend !== "macos-keychain" || keyFingerprint(key) !== d.fingerprint)
      throw new SetupError("backup復号鍵が一致しません。");
    return action(key);
  } finally {
    key.fill(0);
  }
}
export function withRecoveryCode<T>(
  configFile: string,
  action: (code: Buffer) => T,
  transport: KeychainTransport = keychainTransport(configFile),
): T {
  const d = JSON.parse(
      readFileSync(backupKeyFiles(configFile).descriptor, "utf8"),
    ),
    code = transport("read", "recovery-code-" + d.fingerprint);
  try {
    const key = unwrapRecovery(
      readFileSync(backupKeyFiles(configFile).recovery),
      code.toString(),
    );
    key.fill(0);
    return action(code);
  } finally {
    code.fill(0);
  }
}
export function unlockBackupKey(
  configFile: string,
  bytes: Buffer,
  code: string,
  transport: KeychainTransport = keychainTransport(configFile),
) {
  const key = unwrapRecovery(bytes, code),
    d = parseRecovery(bytes);
  try {
    const status = transport("status", "primary").toString().trim();
    if (status === "missing") transport("save", "primary", key);
    else if (status === "present") {
      const current = transport("read", "primary");
      try {
        if (keyFingerprint(current) !== d.fingerprint)
          throw new SetupError("別のbackup鍵があります。上書きしません。");
      } finally {
        current.fill(0);
      }
    } else throw new SetupError("キーチェーン応答が不正です。");
    saveDescriptor(configFile, key);
    const account = "recovery-code-" + d.fingerprint;
    if (transport("status", account).toString().trim() === "missing")
      transport("save", account, Buffer.from(code.trim()));
    writePublic(backupKeyFiles(configFile).recovery, d);
    return {
      fingerprint: d.fingerprint,
      unlocked: true,
      privateKeyFileCreated: false,
      offDeviceVerified: false,
    };
  } finally {
    key.fill(0);
  }
}

// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { directoryDeviceId } from "../directoryDeviceIdentity";
import { asPersonalMemberId } from "@nimbalyst/runtime/auth/jwtScopes";
const account = asPersonalMemberId("account");
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
);
function root() {
  const dir = mkdtempSync(join(tmpdir(), "computer-id-"));
  roots.push(dir);
  return dir;
}

it("shares identity through symlinks and directory moves, but separates copied profiles", () => {
  const base = root();
  const original = join(base, "original");
  const first = directoryDeviceId(original, account);
  symlinkSync(original, join(base, "alias"), "dir");
  expect(directoryDeviceId(join(base, "alias"), account)).toBe(first);
  cpSync(original, join(base, "copy"), { recursive: true });
  expect(directoryDeviceId(join(base, "copy"), account)).not.toBe(first);
  renameSync(original, join(base, "moved"));
  expect(directoryDeviceId(join(base, "moved"), account)).toBe(first);
  writeFileSync(join(base, "moved", "computer-identity"), "broken");
  expect(() => directoryDeviceId(join(base, "moved"), account)).toThrow(
    "restore"
  );
  expect(readFileSync(join(base, "moved", "computer-identity"), "utf8")).toBe(
    "broken"
  );
});

it("publishes one complete identity across concurrent fresh processes", async () => {
  const dir = root();
  const moduleUrl = new URL(
    `file://${resolve(
      "packages/electron/src/main/services/sync/directoryDeviceIdentity.ts"
    )}`
  ).href;
  const code = `import {directoryDeviceId} from ${JSON.stringify(
    moduleUrl
  )}; process.stdout.write(directoryDeviceId(process.argv[1], 'account'));`;
  const runs = await Promise.all(
    Array.from({ length: 4 }, () =>
      promisify(execFile)(process.execPath, [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        code,
        dir,
      ])
    )
  );
  expect(new Set(runs.map((r) => r.stdout)).size).toBe(1);
  expect(runs[0].stdout).toBe(directoryDeviceId(dir, account));
});

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const releaseHelper = fileURLToPath(
  new URL("./create-production-release.mjs", import.meta.url),
);

function runRelease(args, options = {}) {
  return spawnSync(process.execPath, [releaseHelper, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

function fakeGh(script) {
  const directory = mkdtempSync(join(tmpdir(), "release-helper-gh-"));
  const path = join(directory, "gh");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return {
    env: { PATH: `${directory}:${process.env.PATH}` },
    cleanup() {
      rmSync(directory, { force: true, recursive: true });
    },
  };
}

test("builds a main-targeted release command with generated notes", () => {
  const result = runRelease(["v1.2.3", "--dry-run"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "gh 'release' 'create' 'v1.2.3' '--target' 'main' '--title' 'v1.2.3' '--generate-notes'\n",
  );
});

test("rejects tags that are not strict production semver", () => {
  const result = runRelease(["v1.2.3-rc.1", "--dry-run"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /vMAJOR\.MINOR\.PATCH/);
});

test("rejects leading-zero production version components", () => {
  const result = runRelease(["v01.2.3", "--dry-run"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /vMAJOR\.MINOR\.PATCH/);
});

test("dry-run does not invoke gh", () => {
  const gh = fakeGh("exit 99");
  try {
    const result = runRelease(["v1.2.3", "--dry-run"], { env: gh.env });

    assert.equal(result.status, 0, result.stderr);
  } finally {
    gh.cleanup();
  }
});

test("propagates gh release failures", () => {
  const gh = fakeGh('if [ "$1" = "release" ]; then exit 17; fi\nexit 0');
  try {
    const result = runRelease(["v1.2.3"], { env: gh.env });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /gh release create v1\.2\.3.*exited with 17/);
  } finally {
    gh.cleanup();
  }
});

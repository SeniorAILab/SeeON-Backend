import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseFrontendOrigins,
  validateSessionCookie,
  varyContainsOrigin,
} from "./iwinv-overlap-smoke.mjs";

const vectors = JSON.parse(
  await readFile(
    new URL(
      "../../backend/src/config/frontend-origin-conformance.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

for (const vector of vectors.validProduction) {
  test(`origin contract accepts ${vector.name}`, () => {
    assert.deepEqual(parseFrontendOrigins(vector.value), vector.canonical);
  });
}

for (const vector of vectors.invalidProduction) {
  test(`origin contract rejects ${vector.name}`, () => {
    assert.throws(() => parseFrontendOrigins(vector.value));
  });
}

test("Vary requires an exact case-insensitive origin token", () => {
  assert.equal(varyContainsOrigin("Accept-Encoding, oRiGiN"), true);
  assert.equal(varyContainsOrigin("X-Origin-Policy"), false);
  assert.equal(varyContainsOrigin("origin-policy"), false);
  assert.equal(varyContainsOrigin(null), false);
});

test("session cookie requires exact singleton security attributes", () => {
  assert.equal(
    validateSessionCookie(
      ["app_session=fixture; HttpOnly; Secure; SameSite=None; Path=/"],
      { sameSite: "None", secure: true },
    ),
    "app_session=fixture",
  );
  assert.equal(
    validateSessionCookie(
      ["app_session=fixture; HttpOnly; SameSite=Strict; Path=/"],
      { sameSite: "Strict", secure: false },
    ),
    "app_session=fixture",
  );
});

for (const [name, cookie, expected] of [
  [
    "duplicate SameSite",
    "app_session=x; HttpOnly; Secure; SameSite=None; SameSite=None; Path=/",
    { sameSite: "None", secure: true },
  ],
  [
    "conflicting SameSite",
    "app_session=x; HttpOnly; Secure; SameSite=None; SameSite=Strict; Path=/",
    { sameSite: "None", secure: true },
  ],
  [
    "stale SameSite mode",
    "app_session=x; HttpOnly; Secure; SameSite=Strict; Path=/",
    { sameSite: "None", secure: true },
  ],
  [
    "duplicate Secure",
    "app_session=x; HttpOnly; Secure; Secure; SameSite=None; Path=/",
    { sameSite: "None", secure: true },
  ],
  [
    "unexpected Secure",
    "app_session=x; HttpOnly; Secure; SameSite=Strict; Path=/",
    { sameSite: "Strict", secure: false },
  ],
  [
    "missing Secure",
    "app_session=x; HttpOnly; SameSite=None; Path=/",
    { sameSite: "None", secure: true },
  ],
  [
    "duplicate HttpOnly",
    "app_session=x; HttpOnly; HttpOnly; Secure; SameSite=None; Path=/",
    { sameSite: "None", secure: true },
  ],
  [
    "duplicate Path",
    "app_session=x; HttpOnly; Secure; SameSite=None; Path=/; Path=/",
    { sameSite: "None", secure: true },
  ],
  [
    "wrong Path",
    "app_session=x; HttpOnly; Secure; SameSite=None; Path=/api",
    { sameSite: "None", secure: true },
  ],
  [
    "multiple session cookies",
    [
      "app_session=x; HttpOnly; Secure; SameSite=None; Path=/",
      "app_session=y; HttpOnly; Secure; SameSite=None; Path=/",
    ],
    { sameSite: "None", secure: true },
  ],
]) {
  test(`session cookie rejects ${name}`, () => {
    assert.throws(() =>
      validateSessionCookie(
        Array.isArray(cookie) ? cookie : [cookie],
        expected,
      ),
    );
  });
}

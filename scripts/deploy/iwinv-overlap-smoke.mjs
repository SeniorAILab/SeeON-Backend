import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const base = "http://api-ingress:3000";
const requestedMethod = "GET";
const requestedHeaders = ["content-type", "x-facility-id"];
const absoluteUrlSyntax = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/]*)(.*)$/u;

function check(value, message) {
  if (!value) throw new Error(message);
}

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

export function parseFrontendOrigins(rawValue) {
  check(typeof rawValue === "string", "front-origins-missing");
  check(!containsControlCharacter(rawValue), "front-origins-control");
  const members = rawValue.split(",");
  check(
    members.length > 0 && members.every((entry) => entry.trim().length > 0),
    "front-origins-empty",
  );

  const origins = [];
  const seen = new Set();
  for (const member of members) {
    const entry = member.trim();
    check(entry !== "*", "front-origins-wildcard");
    check(!entry.includes("?"), "front-origins-query");
    check(!entry.includes("#"), "front-origins-hash");
    const syntax = absoluteUrlSyntax.exec(entry);
    check(syntax !== null, "front-origins-invalid-url");
    check(syntax[2] === "" || syntax[2] === "/", "front-origins-path");

    let url;
    try {
      url = new URL(entry);
    } catch {
      throw new Error("front-origins-invalid-url");
    }
    check(
      url.protocol === "http:" || url.protocol === "https:",
      "front-origins-protocol",
    );
    check(
      url.username.length === 0 && url.password.length === 0,
      "front-origins-userinfo",
    );
    check(!url.hostname.includes("*"), "front-origins-wildcard-host");
    check(url.pathname === "/", "front-origins-path");
    check(!isLocalHostname(url.hostname), "front-origins-localhost");
    check(!seen.has(url.origin), "front-origins-duplicate");
    seen.add(url.origin);
    origins.push(url.origin);
  }
  return origins;
}

function isLocalHostname(hostname) {
  const canonical = hostname.toLowerCase().replace(/\.+$/u, "");
  return (
    canonical === "localhost" ||
    canonical.endsWith(".localhost") ||
    canonical.startsWith("127.") ||
    canonical === "[::1]" ||
    canonical.startsWith("[::ffff:7f")
  );
}

function expectedSameSite(rawValue) {
  check(typeof rawValue === "string", "cookie-same-site-mode");
  check(rawValue === "strict" || rawValue === "none", "cookie-same-site-mode");
  return rawValue[0].toUpperCase() + rawValue.slice(1);
}

function expectedSecure(rawValue) {
  check(typeof rawValue === "string", "cookie-secure-mode");
  check(
    rawValue === "true" || rawValue === "false" || rawValue === "auto",
    "cookie-secure-mode",
  );
  return rawValue === "true" || rawValue === "auto";
}

function commaSeparatedTokens(value, normalize) {
  return (value ?? "")
    .split(",")
    .map((token) => normalize(token.trim()))
    .filter(Boolean);
}

export function varyContainsOrigin(value) {
  return commaSeparatedTokens(value, (token) => token.toLowerCase()).includes(
    "origin",
  );
}

function setCookieValues(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const value = headers.get("set-cookie");
  return value === null ? [] : [value];
}

function cookieName(rawCookie) {
  return rawCookie.split(";", 1)[0].split("=", 1)[0].trim().toLowerCase();
}

export function validateSessionCookie(setCookies, expected) {
  const matches = setCookies.filter(
    (rawCookie) => cookieName(rawCookie) === "app_session",
  );
  check(matches.length === 1, "auth-cookie-count");
  const parts = matches[0].split(";").map((token) => token.trim());
  const cookie = parts.shift() ?? "";
  check(/^app_session=.+$/u.test(cookie), "auth-cookie");

  const attributes = new Map();
  for (const part of parts) {
    check(part.length > 0, "cookie-empty-attribute");
    const separator = part.indexOf("=");
    const name = (separator === -1 ? part : part.slice(0, separator))
      .trim()
      .toLowerCase();
    const value = separator === -1 ? null : part.slice(separator + 1).trim();
    const values = attributes.get(name) ?? [];
    values.push(value);
    attributes.set(name, values);
  }

  const httpOnly = attributes.get("httponly") ?? [];
  check(httpOnly.length === 1 && httpOnly[0] === null, "cookie-httponly");
  const paths = attributes.get("path") ?? [];
  check(paths.length === 1 && paths[0] === "/", "cookie-path");
  const sameSites = attributes.get("samesite") ?? [];
  check(sameSites.length === 1, "cookie-samesite-count");
  check(
    sameSites[0]?.toLowerCase() === expected.sameSite.toLowerCase(),
    "cookie-samesite-mode",
  );
  const secure = attributes.get("secure") ?? [];
  if (expected.secure) {
    check(secure.length === 1 && secure[0] === null, "cookie-secure");
  } else {
    check(secure.length === 0, "cookie-secure-unexpected");
  }
  return cookie;
}

function expectedRuntimeConfiguration() {
  const authorities = [
    ["FRONT_ORIGINS", "EXPECTED_FRONT_ORIGINS", "runtime-front-origins-drift"],
    [
      "AUTH_COOKIE_SAME_SITE",
      "EXPECTED_AUTH_COOKIE_SAME_SITE",
      "runtime-cookie-same-site-drift",
    ],
    [
      "AUTH_COOKIE_SECURE",
      "EXPECTED_AUTH_COOKIE_SECURE",
      "runtime-cookie-secure-drift",
    ],
  ];
  for (const [runtimeKey, expectedKey, message] of authorities) {
    check(
      typeof process.env[expectedKey] === "string",
      `${expectedKey}-missing`,
    );
    check(process.env[runtimeKey] === process.env[expectedKey], message);
  }
  return {
    origins: parseFrontendOrigins(process.env.FRONT_ORIGINS),
    sameSite: expectedSameSite(process.env.AUTH_COOKIE_SAME_SITE),
    secure: expectedSecure(process.env.AUTH_COOKIE_SECURE),
  };
}

function credentialBody() {
  check(
    process.env.SUPER_ADMIN_EMAIL && process.env.SUPER_ADMIN_PASSWORD,
    "smoke-credentials",
  );
  return JSON.stringify({
    email: process.env.SUPER_ADMIN_EMAIL,
    password: process.env.SUPER_ADMIN_PASSWORD,
  });
}

async function verifyOrigin(origin, cookieExpectation) {
  const forwarded = { Origin: origin, "X-Forwarded-Proto": "https" };
  const preflight = await fetch(`${base}/api/v1/auth/me`, {
    method: "OPTIONS",
    headers: {
      ...forwarded,
      "Access-Control-Request-Method": requestedMethod,
      "Access-Control-Request-Headers": requestedHeaders.join(","),
    },
  });
  check(preflight.ok, "cors-preflight");
  check(
    preflight.headers.get("access-control-allow-origin") === origin,
    "cors-origin",
  );
  check(
    preflight.headers.get("access-control-allow-credentials") === "true",
    "cors-credentials",
  );
  check(varyContainsOrigin(preflight.headers.get("vary")), "cors-vary");

  const allowedMethods = commaSeparatedTokens(
    preflight.headers.get("access-control-allow-methods"),
    (value) => value.toUpperCase(),
  );
  check(allowedMethods.includes(requestedMethod), "cors-method");
  const allowedHeaders = commaSeparatedTokens(
    preflight.headers.get("access-control-allow-headers"),
    (value) => value.toLowerCase(),
  );
  for (const header of requestedHeaders)
    check(allowedHeaders.includes(header), `cors-header-${header}`);

  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { ...forwarded, "Content-Type": "application/json" },
    body: credentialBody(),
  });
  check(login.ok, "auth-login");
  const cookie = validateSessionCookie(
    setCookieValues(login.headers),
    cookieExpectation,
  );

  const loginBody = await login.json();
  const me = await fetch(`${base}/api/v1/auth/me`, {
    headers: { ...forwarded, Cookie: cookie },
  });
  check(me.ok, "auth-me");
  let facilityId = loginBody.user?.facilityId ?? null;
  if (!facilityId) {
    const facilities = await fetch(`${base}/api/v1/facilities`, {
      headers: { ...forwarded, Cookie: cookie },
    });
    check(facilities.ok, "facilities");
    const rows = await facilities.json();
    facilityId = Array.isArray(rows) ? rows[0]?.id : null;
  }
  check(
    typeof facilityId === "string" && facilityId.length > 0,
    "facility-scope",
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const stream = await fetch(
      `${base}/api/v1/dashboard/stream?facilityId=${encodeURIComponent(facilityId)}`,
      {
        headers: { ...forwarded, Cookie: cookie },
        signal: controller.signal,
      },
    );
    check(stream.ok, "sse-status");
    check(
      commaSeparatedTokens(stream.headers.get("content-type"), (value) =>
        value.toLowerCase(),
      ).some((value) => value.startsWith("text/event-stream")),
      "sse-content-type",
    );
    check(
      stream.headers.get("access-control-allow-origin") === origin,
      "sse-cors",
    );
    const first = await stream.body.getReader().read();
    check(
      !first.done &&
        new TextDecoder().decode(first.value).includes(": connected"),
      "sse-open",
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function verifyRejectedOrigin(origins) {
  let rejectedOrigin = "https://cors-rejection.invalid";
  while (origins.includes(rejectedOrigin))
    rejectedOrigin = `https://x.${new URL(rejectedOrigin).hostname}`;
  const forwarded = {
    Origin: rejectedOrigin,
    "X-Forwarded-Proto": "https",
  };
  const rejected = await fetch(`${base}/api/v1/auth/me`, {
    method: "OPTIONS",
    headers: {
      ...forwarded,
      "Access-Control-Request-Method": requestedMethod,
      "Access-Control-Request-Headers": requestedHeaders.join(","),
    },
  });
  check(
    !rejected.headers.has("access-control-allow-origin"),
    "rejected-origin-cors",
  );
  check(
    !rejected.headers.has("access-control-allow-credentials"),
    "rejected-origin-credentials",
  );

  const rejectedLogin = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { ...forwarded, "Content-Type": "application/json" },
    body: credentialBody(),
  });
  check(!rejectedLogin.ok, "rejected-origin-login");
  check(
    setCookieValues(rejectedLogin.headers).every(
      (cookie) => cookieName(cookie) !== "app_session",
    ),
    "rejected-origin-cookie",
  );
}

export async function runOverlapSmoke() {
  const expected = expectedRuntimeConfiguration();
  for (const origin of expected.origins) await verifyOrigin(origin, expected);
  await verifyRejectedOrigin(expected.origins);
  console.log("OVERLAP_SMOKE_OK");
}

const invokedPath = process.argv[1];
const isDirectExecution =
  invokedPath === undefined ||
  import.meta.url === pathToFileURL(resolve(invokedPath)).href;
if (isDirectExecution) {
  try {
    await runOverlapSmoke();
  } catch (error) {
    console.error(
      `OVERLAP_SMOKE_FAILED ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

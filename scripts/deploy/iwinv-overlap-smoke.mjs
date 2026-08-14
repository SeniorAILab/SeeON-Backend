const base = "http://api-ingress:3000";
const requestedMethod = "GET";
const requestedHeaders = ["content-type", "x-facility-id"];

function check(value, message) {
  if (!value) throw new Error(message);
}

function parseFrontendOrigins(rawValue) {
  check(typeof rawValue === "string", "front-origins-missing");
  const entries = rawValue.split(",").map((entry) => entry.trim());
  check(entries.length > 0 && entries.every(Boolean), "front-origins-empty");

  const origins = [];
  const seen = new Set();
  for (const entry of entries) {
    check(entry !== "*", "front-origins-wildcard");
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
    check(url.pathname === "/", "front-origins-path");
    check(url.search.length === 0, "front-origins-query");
    check(url.hash.length === 0, "front-origins-hash");
    check(
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
      "front-origins-localhost",
    );
    check(!seen.has(url.origin), "front-origins-duplicate");
    seen.add(url.origin);
    origins.push(url.origin);
  }
  return origins;
}

function expectedSameSiteToken(rawValue) {
  check(typeof rawValue === "string", "cookie-same-site-mode");
  const mode = rawValue.trim();
  check(mode === "strict" || mode === "none", "cookie-same-site-mode");
  return `SameSite=${mode[0].toUpperCase()}${mode.slice(1)}`;
}

function commaSeparatedTokens(value, normalize) {
  return (value ?? "")
    .split(",")
    .map((token) => normalize(token.trim()))
    .filter(Boolean);
}

async function verifyOrigin(origin, sameSiteToken) {
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
  check(
    (preflight.headers.get("vary") ?? "").toLowerCase().includes("origin"),
    "cors-vary",
  );

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

  check(
    process.env.SUPER_ADMIN_EMAIL && process.env.SUPER_ADMIN_PASSWORD,
    "smoke-credentials",
  );
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { ...forwarded, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.SUPER_ADMIN_EMAIL,
      password: process.env.SUPER_ADMIN_PASSWORD,
    }),
  });
  check(login.ok, "auth-login");
  const setCookie = login.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  check(cookie.startsWith("app_session="), "auth-cookie");
  const cookieTokens = setCookie.split(";").map((token) => token.trim());
  for (const token of ["HttpOnly", "Secure", sameSiteToken, "Path=/"]) {
    check(cookieTokens.includes(token), `cookie-${token}`);
  }

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
      (stream.headers.get("content-type") ?? "").includes("text/event-stream"),
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

try {
  const origins = parseFrontendOrigins(process.env.FRONT_ORIGINS);
  const sameSiteToken = expectedSameSiteToken(
    process.env.AUTH_COOKIE_SAME_SITE,
  );
  for (const origin of origins) await verifyOrigin(origin, sameSiteToken);

  let rejectedOrigin = "https://cors-rejection.invalid";
  while (origins.includes(rejectedOrigin))
    rejectedOrigin = `https://x.${new URL(rejectedOrigin).hostname}`;
  const rejected = await fetch(`${base}/api/v1/auth/me`, {
    method: "OPTIONS",
    headers: {
      Origin: rejectedOrigin,
      "X-Forwarded-Proto": "https",
      "Access-Control-Request-Method": requestedMethod,
      "Access-Control-Request-Headers": requestedHeaders.join(","),
    },
  });
  check(
    !rejected.headers.has("access-control-allow-origin"),
    "rejected-origin-cors",
  );
  console.log("OVERLAP_SMOKE_OK");
} catch (error) {
  console.error(
    `OVERLAP_SMOKE_FAILED ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

# Authentication boundary

- Browser auth uses the HttpOnly session cookie. Edge credentials are a separate machine boundary.
- Enforce `sessionVersion`, role capability, and facility scope on every tenant operation; logout invalidates existing sessions.
- Never trust facility IDs, roles, or actor IDs from request bodies. Derive them from the authenticated context.
- Keep SUPER_ADMIN behavior explicit; it does not implicitly bypass facility-scoped media or note rules.


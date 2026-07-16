# Media boundary

- Edge ingest uses the edge credential; admin reads use the user session and facility scope. Never interchange them.
- A clip is immutable after READY. Keep facility, clip, event references, checksum, byte length, duration, and state version consistent.
- Store only server-derived paths. Reject traversal and symlinks; publish atomically and reconcile DB/filesystem state after interruption.
- Content reads must preserve Range/ETag behavior, close file handles, and append access audit records. Holds block expiry and deletion.
- Keep the media feature flag fail-closed. Do not synthesize proxy credentials or expose edge URLs to the browser.


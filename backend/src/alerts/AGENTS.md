# Alert domain boundary

- `AlertWriterService.writeAlert()` is the only alert insert path. It serializes inserts through an in-process promise chain so `alertSeq`, transaction commit, and SSE emit share one causal order. Never insert `alerts` rows around it.
- `AlertsService` is read-only (dashboard queries + snapshot proxy). Keep read and write paths separate.
- Live ingest (`EventAlarmService`) derives the alert only. The outbox and email fan-out belong to `AlertEventsService`, which runs as separate delivery infrastructure, never inline on the ingest request.
- Delivery goes through `ALERT_CHANNEL_PORT`; `EmailChannelAdapter` is one implementation. Services depend on the port, not the adapter. `DeliveryResult` failures must stay classified as `transient` or `terminal_operator_action`.
- `AlertPolicyService` currently dispatches unconditionally; it is the designated seat for suppression/dedupe rules. Add policy there, not in the writer or the controller.
- Resident display context (`resident_name`, `resident_room`) is joined backend-side and must never be read from an ML ingest DTO.

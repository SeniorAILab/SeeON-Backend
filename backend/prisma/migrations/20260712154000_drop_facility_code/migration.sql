-- Facility.code (human-readable string code) is removed from the product.
-- DB-issued facility ids are the only identifier; no UX requires a human to
-- re-type a string code, so the column and its unique index are dropped.
ALTER TABLE facilities DROP COLUMN code;

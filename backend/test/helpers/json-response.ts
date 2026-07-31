export type JsonObject = Readonly<Record<string, unknown>>;

export function readObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

export function readString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

export function readNumber(value: unknown, label: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${label} must be a number`);
  }
  return value;
}

export function readNullableString(
  value: unknown,
  label: string,
): string | null {
  if (value === null) {
    return null;
  }
  return readString(value, label);
}

export function readObjectField(object: JsonObject, field: string): JsonObject {
  return readObject(object[field], field);
}

export function readArrayField(
  object: JsonObject,
  field: string,
): readonly unknown[] {
  return readArray(object[field], field);
}

export function readStringField(object: JsonObject, field: string): string {
  return readString(object[field], field);
}

export function readNullableStringField(
  object: JsonObject,
  field: string,
): string | null {
  return readNullableString(object[field], field);
}

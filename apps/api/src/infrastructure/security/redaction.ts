const REDACTED = "[REDACTED]";
const REDACTED_URL = "[REDACTED_URL]";

export function redactSensitiveText(value: unknown, knownSecrets: Array<string | null | undefined> = []) {
  let text = value instanceof Error ? value.message : String(value ?? "");

  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4) text = text.split(secret).join(REDACTED);
  }

  return text
    .replace(/\b(?:postgres(?:ql)?|redis):\/\/[^\s"']+/gi, REDACTED_URL)
    .replace(/(--database-url(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, `$1${REDACTED}`)
    .replace(/\b(DATABASE_URL|REDIS_URL|POSTGRES_PASSWORD)=([^\s]+)/gi, `$1=${REDACTED}`);
}

export function redactSensitiveValue(value: unknown, knownSecrets: Array<string | null | undefined> = []): unknown {
  if (typeof value === "string" || value instanceof Error) {
    return redactSensitiveText(value, knownSecrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item, knownSecrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSensitiveValue(item, knownSecrets)])
    );
  }
  return value;
}

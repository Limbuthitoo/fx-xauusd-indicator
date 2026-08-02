#!/usr/bin/env python3
"""
Generate and sync a production admin password.

This helper matches the backend password format:
  scrypt:<salt_hex>:<derived_hash_hex>

It can update ADMIN_PASSWORD in .env.production and write a SQL snippet
that updates admin_users.password_hash for an existing deployed admin.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import re
import secrets
import string
import subprocess
from pathlib import Path
from typing import Optional


BLOCKED_RE = re.compile(r"(change-this|password|admin|1234)", re.IGNORECASE)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate/sync platform admin password safely.")
    parser.add_argument("--env", default=".env.production", help="Environment file to update.")
    parser.add_argument("--email", help="Admin email for SQL output. Defaults to ADMIN_EMAIL from env.")
    parser.add_argument("--sql-file", help="Write SQL update snippet to this file.")
    parser.add_argument("--no-env-update", action="store_true", help="Do not update ADMIN_PASSWORD in env file.")
    parser.add_argument("--password-stdin", action="store_true", help="Read the new password from stdin.")
    parser.add_argument("--verify-hash", help="Verify the password against an existing scrypt hash and exit.")
    args = parser.parse_args()

    env_path = Path(args.env)
    env = read_env(env_path)

    if args.password_stdin:
        password = input().rstrip("\n")
    else:
        password = generate_password()

    password_error = validate_password(password)
    if password_error:
        raise SystemExit(f"Password rejected: {password_error}")

    if args.verify_hash:
        ok = verify_password(password, args.verify_hash)
        print("MATCH" if ok else "NO_MATCH")
        return 0 if ok else 1

    password_hash = hash_password(password)
    admin_email = args.email or env.get("ADMIN_EMAIL", "").strip()

    if not args.no_env_update:
        write_env_value(env_path, "ADMIN_PASSWORD", password)

    if args.sql_file:
        if not admin_email or is_placeholder(admin_email):
            raise SystemExit("SQL output needs a real admin email. Set ADMIN_EMAIL in env or pass --email.")
        Path(args.sql_file).write_text(sql_for_password(admin_email, password_hash), encoding="utf-8")

    print("Admin password helper complete.")
    print(f"Env file: {env_path}")
    print(f"ADMIN_PASSWORD updated: {'no' if args.no_env_update else 'yes'}")
    print(f"SQL file: {args.sql_file or 'not written'}")
    print("")
    print("New admin password. Store it in your password manager now:")
    print(password)
    print("")
    print("Password hash for database sync:")
    print(password_hash)
    return 0


def generate_password(length: int = 24) -> str:
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*()-_=+"
    while True:
        password = "".join(secrets.choice(alphabet) for _ in range(length))
        if validate_password(password) is None:
            return password


def validate_password(password: str) -> Optional[str]:
    if len(password) < 12:
        return "must be at least 12 characters."
    if not re.search(r"[a-z]", password):
        return "must include a lowercase letter."
    if not re.search(r"[A-Z]", password):
        return "must include an uppercase letter."
    if not re.search(r"[0-9]", password):
        return "must include a number."
    if not re.search(r"[^A-Za-z0-9]", password):
        return "must include a symbol."
    if BLOCKED_RE.search(password):
        return "contains a blocked weak phrase."
    return None


def hash_password(password: str) -> str:
    salt_hex = secrets.token_hex(16)
    # Node's crypto.scrypt receives the salt as the hex string, not decoded bytes.
    derived = scrypt_derive(password, salt_hex)
    return f"scrypt:{salt_hex}:{derived.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_hex, hash_hex = stored.split(":", 2)
        if scheme != "scrypt":
            return False
        derived = scrypt_derive(password, salt_hex)
        return hmac.compare_digest(derived.hex(), hash_hex)
    except ValueError:
        return False


def scrypt_derive(password: str, salt_hex: str) -> bytes:
    if hasattr(hashlib, "scrypt"):
        return hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt_hex.encode("utf-8"),
            n=16384,
            r=8,
            p=1,
            dklen=64,
        )

    script = """
const crypto = require("node:crypto");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const derived = crypto.scryptSync(input.password, input.salt, 64);
  process.stdout.write(derived.toString("hex"));
});
"""
    completed = subprocess.run(
        ["node", "-e", script],
        input=json.dumps({"password": password, "salt": salt_hex}),
        text=True,
        capture_output=True,
        check=True,
    )
    return bytes.fromhex(completed.stdout.strip())


def read_env(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    result: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        result[key] = value.strip().strip('"').strip("'")
    return result


def write_env_value(path: Path, key: str, value: str) -> None:
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    replaced = False
    next_lines = []
    for line in lines:
        if line.startswith(f"{key}="):
            next_lines.append(f"{key}={value}")
            replaced = True
        else:
            next_lines.append(line)
    if not replaced:
        next_lines.append(f"{key}={value}")
    path.write_text("\n".join(next_lines).rstrip() + "\n", encoding="utf-8")


def sql_for_password(email: str, password_hash: str) -> str:
    escaped_email = sql_quote(email.lower())
    escaped_hash = sql_quote(password_hash)
    return (
        "BEGIN;\n"
        "UPDATE admin_users\n"
        f"   SET password_hash = {escaped_hash},\n"
        "       password_changed_at = now(),\n"
        "       updated_at = now()\n"
        f" WHERE lower(email) = lower({escaped_email});\n"
        "UPDATE admin_sessions\n"
        "   SET revoked_at = now(), last_seen_at = now()\n"
        " WHERE admin_user_id IN (\n"
        f"   SELECT id FROM admin_users WHERE lower(email) = lower({escaped_email})\n"
        " ) AND revoked_at IS NULL;\n"
        "COMMIT;\n"
    )


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def is_placeholder(value: str) -> bool:
    return not value or "change-this" in value or "example" in value


if __name__ == "__main__":
    raise SystemExit(main())

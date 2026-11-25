import json
import os
import sqlite3
import sys
from datetime import datetime

if getattr(sys, "frozen", False):
    BASE_DIR = os.path.dirname(os.path.abspath(sys.executable))
    DATA_DIR = os.path.join(
        os.environ.get("LOCALAPPDATA") or BASE_DIR,
        "ScovilleOverdueAlerts",
    )
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    DATA_DIR = os.path.join(BASE_DIR, "data")

DB_PATH = os.path.join(DATA_DIR, "scoville_alerts.db")

SEED_DIRECTORY = [
    ("Adelio", "ALopez@qiworks.com", 1, 0),
    ("Akash", "akanday@qiworks.com", 1, 0),
    ("Brenton", "blowery@qiworks.com", 0, 1),
    ("Brian", "bmasta@qiworks.com", 1, 0),
    ("Carlos", "CCuevas@qiworks.com", 0, 1),
    ("Charles", "cpowell@qiworks.com", 1, 0),
    ("Dominique", "dbaum@qiworks.com", 1, 0),
    ("Garrett", "gbabin@qiworks.com", 1, 0),
    ("Jared", "jleduc@qiworks.com", 0, 1),
    ("Jerrell", "jerrelldowd@qiworks.com", 0, 1),
    ("Kyle", "ktingle@qiworks.com", 0, 1),
    ("Nicholas", "ngarrett@qiworks.com", 1, 0),
    ("Polo", "pinfante@qiworks.com", 0, 1),
    ("Randy", "rcrabtree@qiworks.com", 1, 0),
    ("Steven", "srayas@qiworks.com", 0, 1),
]

DEFAULT_SETTINGS = {
    "scoville_url": os.environ.get("SCOVILLE_URL", "http://scoville:7555"),
    "scoville_email": os.environ.get("SCOVILLE_EMAIL", ""),
    "scoville_password": os.environ.get("SCOVILLE_PASSWORD", ""),
    "from_email": "",
    "from_name": "Scoville Detailing Alerts",
    "email_subject": "Overdues on Scoville",
    "zero_value_subject": "$0 Items on Scoville",
    "bom_email_subject": "Missing BOM Email",
    "bom_grace_hours": 2,
    "bom_since_date": "2026-11-24",
    "default_recipient_email": "akanday@qiworks.com",
    "grouping_mode": "digest",          # "digest" (per person) or "per_item" (per QKEY)
    "delivery_mode": "outlook_send",    # "outlook_send", "outlook_draft", "smtp", "dry_run"
    "outlook_send_on_behalf": False,
    "smtp_host": "smtp.office365.com",
    "smtp_port": 587,
    "smtp_use_tls": True,
    "smtp_use_ssl": False,
    "smtp_username": "detailing@qiworks.com",
    "smtp_password": "",
    "cc_emails": "",
    "exclude_on_hold": True,
    "include_due_today": False,
    "schedule_enabled": False,
    "schedule_time": "08:00",
    "schedule_weekdays_only": True,
    "last_auto_run_date": "",
}


def get_conn() -> sqlite3.Connection:
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS directory (
                name TEXT PRIMARY KEY,
                email TEXT NOT NULL,
                is_dpm INTEGER NOT NULL DEFAULT 0,
                is_ps INTEGER NOT NULL DEFAULT 0,
                active INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sync_cache (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                synced_at TEXT NOT NULL,
                items_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS email_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                recipient_label TEXT NOT NULL,
                to_emails TEXT NOT NULL,
                cc_emails TEXT NOT NULL,
                from_email TEXT NOT NULL,
                subject TEXT NOT NULL,
                delivery_mode TEXT NOT NULL,
                status TEXT NOT NULL,
                item_count INTEGER NOT NULL DEFAULT 0,
                qkeys_json TEXT NOT NULL DEFAULT '[]',
                error_message TEXT NOT NULL DEFAULT '',
                html_body TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS bom_seen (
                job_lot_key TEXT PRIMARY KEY,
                job_number TEXT NOT NULL,
                lot_number TEXT NOT NULL,
                subject TEXT NOT NULL DEFAULT '',
                sender TEXT NOT NULL DEFAULT '',
                received_at TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT 'outlook',
                recorded_at TEXT NOT NULL
            );
            """
        )
        # Populate missing default settings
        for k, v in DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
                (k, json.dumps(v)),
            )
        # Seed known QIWorks DPM & PS directory emails on fresh installs
        now = datetime.now().isoformat(timespec="seconds")
        for name, email, is_dpm, is_ps in SEED_DIRECTORY:
            conn.execute(
                "INSERT OR IGNORE INTO directory (name, email, is_dpm, is_ps, active, updated_at) "
                "VALUES (?, ?, ?, ?, 1, ?)",
                (name, email, is_dpm, is_ps, now),
            )
        # One-time migration to switch existing DB from detailing@qiworks.com to local Outlook account
        mig = conn.execute("SELECT value FROM settings WHERE key = '_migrated_local_outlook'").fetchone()
        if mig is None:
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('outlook_send_on_behalf', 'false')")
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('from_email', '\"\"')")
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('_migrated_local_outlook', 'true')")
        conn.commit()


def get_settings() -> dict:
    init_db()
    result = dict(DEFAULT_SETTINGS)
    with get_conn() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        for r in rows:
            try:
                result[r["key"]] = json.loads(r["value"])
            except Exception:
                result[r["key"]] = r["value"]
    return result


def update_settings(updates: dict) -> dict:
    init_db()
    with get_conn() as conn:
        for k, v in updates.items():
            if k in DEFAULT_SETTINGS:
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (k, json.dumps(v)),
                )
        conn.commit()
    return get_settings()


def sync_directory_names(dpm_names: set[str], ps_names: set[str], default_email: str) -> list[dict]:
    """Ensure all discovered DPM and PS names from Scoville exist in the directory."""
    init_db()
    now = datetime.now().isoformat(timespec="seconds")
    all_names = sorted({n.strip() for n in (dpm_names | ps_names) if n and n.strip()})
    with get_conn() as conn:
        for name in all_names:
            is_dpm = 1 if name in dpm_names else 0
            is_ps = 1 if name in ps_names else 0
            existing = conn.execute(
                "SELECT name, is_dpm, is_ps FROM directory WHERE name = ?", (name,)
            ).fetchone()
            if existing is None:
                conn.execute(
                    "INSERT INTO directory (name, email, is_dpm, is_ps, active, updated_at) "
                    "VALUES (?, ?, ?, ?, 1, ?)",
                    (name, default_email, is_dpm, is_ps, now),
                )
            else:
                new_dpm = max(existing["is_dpm"], is_dpm)
                new_ps = max(existing["is_ps"], is_ps)
                if new_dpm != existing["is_dpm"] or new_ps != existing["is_ps"]:
                    conn.execute(
                        "UPDATE directory SET is_dpm = ?, is_ps = ? WHERE name = ?",
                        (new_dpm, new_ps, name),
                    )
        conn.commit()
    return get_directory()


def get_directory() -> list[dict]:
    init_db()
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT name, email, is_dpm, is_ps, active, updated_at "
            "FROM directory ORDER BY is_dpm DESC, name COLLATE NOCASE ASC"
        ).fetchall()
        return [
            {
                "name": r["name"],
                "email": r["email"],
                "is_dpm": bool(r["is_dpm"]),
                "is_ps": bool(r["is_ps"]),
                "active": bool(r["active"]),
                "updated_at": r["updated_at"],
            }
            for r in rows
        ]


def upsert_directory_entry(name: str, email: str, is_dpm: bool = False, is_ps: bool = False, active: bool = True) -> None:
    init_db()
    now = datetime.now().isoformat(timespec="seconds")
    clean_name = name.strip()
    clean_email = email.strip()
    if not clean_name:
        return
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT is_dpm, is_ps FROM directory WHERE name = ?", (clean_name,)
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE directory SET email = ?, active = ?, updated_at = ? WHERE name = ?",
                (clean_email, 1 if active else 0, now, clean_name),
            )
        else:
            conn.execute(
                "INSERT INTO directory (name, email, is_dpm, is_ps, active, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (clean_name, clean_email, 1 if is_dpm else 0, 1 if is_ps else 0, 1 if active else 0, now),
            )
        conn.commit()


def bulk_update_directory(entries: list[dict]) -> list[dict]:
    init_db()
    now = datetime.now().isoformat(timespec="seconds")
    with get_conn() as conn:
        for entry in entries:
            name = (entry.get("name") or "").strip()
            if not name:
                continue
            email = (entry.get("email") or "").strip()
            active = 1 if entry.get("active", True) else 0
            is_dpm = 1 if entry.get("is_dpm", False) else 0
            is_ps = 1 if entry.get("is_ps", False) else 0
            conn.execute(
                """
                INSERT INTO directory (name, email, is_dpm, is_ps, active, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    email = excluded.email,
                    active = excluded.active,
                    updated_at = excluded.updated_at
                """,
                (name, email, is_dpm, is_ps, active, now),
            )
        conn.commit()
    return get_directory()


def save_sync_cache(cache_payload: dict | list, synced_at: str | None = None) -> str:
    init_db()
    ts = synced_at or datetime.now().isoformat(timespec="seconds")
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO sync_cache (id, synced_at, items_json)
            VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                synced_at = excluded.synced_at,
                items_json = excluded.items_json
            """,
            (ts, json.dumps(cache_payload)),
        )
        conn.commit()
    return ts


def get_sync_cache() -> tuple[str | None, dict]:
    init_db()
    with get_conn() as conn:
        row = conn.execute("SELECT synced_at, items_json FROM sync_cache WHERE id = 1").fetchone()
        if not row:
            return None, {"items": [], "zero_value_items": None, "zero_value_scanned": 0}
        try:
            parsed = json.loads(row["items_json"])
            if isinstance(parsed, list):
                return row["synced_at"], {"items": parsed, "zero_value_items": None, "zero_value_scanned": 0}
            if isinstance(parsed, dict):
                return row["synced_at"], parsed
            return row["synced_at"], {"items": [], "zero_value_items": None, "zero_value_scanned": 0}
        except Exception:
            return row["synced_at"], {"items": [], "zero_value_items": None, "zero_value_scanned": 0}


def add_email_log(
    recipient_label: str,
    to_emails: list[str],
    cc_emails: list[str],
    from_email: str,
    subject: str,
    delivery_mode: str,
    status: str,
    item_count: int,
    qkeys: list[str],
    html_body: str,
    error_message: str = "",
) -> int:
    init_db()
    now = datetime.now().isoformat(timespec="seconds")
    with get_conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO email_logs (
                created_at, recipient_label, to_emails, cc_emails, from_email,
                subject, delivery_mode, status, item_count, qkeys_json,
                error_message, html_body
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                now,
                recipient_label,
                ", ".join(to_emails),
                ", ".join(cc_emails),
                from_email,
                subject,
                delivery_mode,
                status,
                item_count,
                json.dumps(qkeys),
                error_message,
                html_body,
            ),
        )
        conn.commit()
        return int(cur.lastrowid)


def get_email_logs(limit: int = 100) -> list[dict]:
    init_db()
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, recipient_label, to_emails, cc_emails,
                   from_email, subject, delivery_mode, status, item_count,
                   qkeys_json, error_message
            FROM email_logs
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        result = []
        for r in rows:
            try:
                qkeys = json.loads(r["qkeys_json"])
            except Exception:
                qkeys = []
            result.append(
                {
                    "id": r["id"],
                    "created_at": r["created_at"],
                    "recipient_label": r["recipient_label"],
                    "to_emails": r["to_emails"],
                    "cc_emails": r["cc_emails"],
                    "from_email": r["from_email"],
                    "subject": r["subject"],
                    "delivery_mode": r["delivery_mode"],
                    "status": r["status"],
                    "item_count": r["item_count"],
                    "qkeys": qkeys,
                    "error_message": r["error_message"],
                }
            )
        return result


def get_email_log_detail(log_id: int) -> dict | None:
    init_db()
    with get_conn() as conn:
        r = conn.execute("SELECT * FROM email_logs WHERE id = ?", (log_id,)).fetchone()
        if not r:
            return None
        try:
            qkeys = json.loads(r["qkeys_json"])
        except Exception:
            qkeys = []
        return {
            "id": r["id"],
            "created_at": r["created_at"],
            "recipient_label": r["recipient_label"],
            "to_emails": r["to_emails"],
            "cc_emails": r["cc_emails"],
            "from_email": r["from_email"],
            "subject": r["subject"],
            "delivery_mode": r["delivery_mode"],
            "status": r["status"],
            "item_count": r["item_count"],
            "qkeys": qkeys,
            "error_message": r["error_message"],
            "html_body": r["html_body"],
        }


def delete_email_log(log_id: int) -> None:
    init_db()
    with get_conn() as conn:
        conn.execute("DELETE FROM email_logs WHERE id = ?", (log_id,))
        conn.commit()


def clear_email_logs(errors_only: bool = False) -> int:
    init_db()
    with get_conn() as conn:
        if errors_only:
            cur = conn.execute("DELETE FROM email_logs WHERE status = 'error'")
        else:
            cur = conn.execute("DELETE FROM email_logs")
        conn.commit()
        return int(cur.rowcount or 0)


def normalize_job_lot_key(job_number: str, lot_number: str) -> str:
    import re
    j = (job_number or "").strip()
    raw_lot = (lot_number or "").strip().upper().lstrip("#")
    m = re.fullmatch(r"([A-Z]{1,3})0*(\d{1,4})", raw_lot)
    if m:
        prefix, digits = m.group(1), m.group(2)
        num_val = int(digits)
        canon_lot = f"{prefix}{num_val:03d}" if num_val < 1000 else f"{prefix}{num_val}"
    else:
        canon_lot = raw_lot
    return f"{j}:{canon_lot}"


def upsert_bom_seen_entries(entries: list[dict]) -> int:
    """Permanently records seen BOM emails by Job # + Lot/FAB # so deleted Inbox items stay marked sent."""
    if not entries:
        return 0
    init_db()
    now = datetime.now().isoformat(timespec="seconds")
    added = 0
    with get_conn() as conn:
        for e in entries:
            j_num = (e.get("job_number") or "").strip()
            l_num = (e.get("lot_number") or "").strip().upper().lstrip("#")
            if not j_num or not l_num:
                continue
            key = normalize_job_lot_key(j_num, l_num)
            cur = conn.execute(
                """
                INSERT OR IGNORE INTO bom_seen (
                    job_lot_key, job_number, lot_number, subject, sender, received_at, source, recorded_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    key,
                    j_num,
                    key.split(":", 1)[1],
                    (e.get("subject") or "")[:300],
                    (e.get("sender") or "")[:160],
                    (e.get("received_at") or "")[:40],
                    (e.get("source") or "outlook")[:40],
                    now,
                ),
            )
            if cur.rowcount and cur.rowcount > 0:
                added += 1
        conn.commit()
    return added


def mark_bom_sent_manual(job_number: str, lot_number: str, note: str = "Marked sent manually") -> str:
    key = normalize_job_lot_key(job_number, lot_number)
    upsert_bom_seen_entries(
        [
            {
                "job_number": job_number,
                "lot_number": lot_number,
                "subject": note,
                "sender": "Manual Override",
                "received_at": datetime.now().isoformat(timespec="seconds"),
                "source": "manual",
            }
        ]
    )
    return key


def get_bom_seen_map() -> dict[str, dict]:
    init_db()
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT job_lot_key, job_number, lot_number, subject, sender, received_at, source, recorded_at FROM bom_seen"
        ).fetchall()
        return {dict(r)["job_lot_key"]: dict(r) for r in rows}


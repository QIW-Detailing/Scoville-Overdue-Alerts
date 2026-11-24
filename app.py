from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import date, datetime
from email.message import EmailMessage
from flask import Flask, Response, jsonify, render_template, request

import db
from mailer import (
    _parse_email_list,
    deliver_email,
    render_packet_email,
    resolve_effective_sender,
)
from scoville_client import (
    TRACKED_MILESTONES,
    evaluate_items_and_packets,
    fetch_scoville_data,
)

IS_FROZEN = getattr(sys, "frozen", False)
RESOURCE_DIR = sys._MEIPASS if IS_FROZEN else os.path.dirname(os.path.abspath(__file__))

app = Flask(
    __name__,
    template_folder=os.path.join(RESOURCE_DIR, "templates"),
    static_folder=os.path.join(RESOURCE_DIR, "static"),
)
_sync_lock = threading.Lock()


def write_public_snapshot(synced_at: str | None, cache_payload: dict, directory: list[dict]) -> None:
    """Writes a password-free snapshot.json when running from the repo folder."""
    if IS_FROZEN or not synced_at:
        return
    try:
        snap_path = os.path.join(RESOURCE_DIR, "snapshot.json")
        snap_data = {
            "synced_at": synced_at,
            "milestones": TRACKED_MILESTONES,
            "items": cache_payload.get("items") or [],
            "zero_value_items": cache_payload.get("zero_value_items") or [],
            "zero_value_scanned": int(cache_payload.get("zero_value_scanned") or 0),
            "directory": directory,
        }
        with open(snap_path, "w", encoding="utf-8") as f:
            json.dump(snap_data, f)

        def _bg_push_snapshot() -> None:
            try:
                if not os.path.isdir(os.path.join(RESOURCE_DIR, ".git")):
                    return
                subprocess.run(["git", "add", "snapshot.json"], cwd=RESOURCE_DIR, capture_output=True, timeout=10)
                subprocess.run(
                    ["git", "commit", "-m", f"Auto-sync snapshot ({synced_at})"],
                    cwd=RESOURCE_DIR,
                    capture_output=True,
                    timeout=10,
                )
                subprocess.run(["git", "push", "origin", "main"], cwd=RESOURCE_DIR, capture_output=True, timeout=20)
            except Exception:
                pass

        threading.Thread(target=_bg_push_snapshot, daemon=True).start()
    except Exception:
        pass


@app.before_request
def _handle_cors_preflight():
    if request.method == "OPTIONS":
        resp = app.make_default_options_response()
        resp.headers["Access-Control-Allow-Origin"] = request.headers.get("Origin", "*")
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Accept"
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
        resp.headers["Access-Control-Allow-Local-Network"] = "true"
        return resp
    return None


@app.after_request
def _add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = request.headers.get("Origin", "*")
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Accept"
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    resp.headers["Access-Control-Allow-Local-Network"] = "true"
    return resp


@app.route("/api/ping", methods=["GET"])
def api_ping():
    return jsonify({"ok": True})


def perform_scoville_sync() -> tuple[str, dict, list[dict]]:
    """Synchronizes items & $0 items from Scoville and updates discovered DPM/PS names."""
    with _sync_lock:
        settings = db.get_settings()
        cache_payload = fetch_scoville_data(
            base_url=settings["scoville_url"],
            email=settings["scoville_email"],
            password=settings["scoville_password"],
        )
        items = cache_payload.get("items", [])
        z_items = cache_payload.get("zero_value_items", [])
        dpm_names = {
            it["dpm"] for it in (items + z_items) if it.get("dpm") and it["dpm"] != "Unassigned"
        }
        ps_names = {
            it["ps"] for it in (items + z_items) if it.get("ps") and it["ps"] != "Unassigned"
        }
        directory = db.sync_directory_names(
            dpm_names=dpm_names,
            ps_names=ps_names,
            default_email=settings.get("default_recipient_email", "akanday@qiworks.com"),
        )
        synced_at = db.save_sync_cache(cache_payload)
        write_public_snapshot(synced_at, cache_payload, directory)
        return synced_at, cache_payload, directory


def _parse_bool_arg(val: str | None, default: bool | None = None) -> bool | None:
    if val is None or val == "":
        return default
    return val.lower() in ("1", "true", "yes", "on")


def _build_current_evaluation(
    as_of: str | None = None,
    include_due_today: bool | None = None,
    exclude_on_hold: bool | None = None,
    milestone_filter: str | None = None,
    auto_sync_if_empty: bool = False,
    due_soon_days: int = 7,
) -> tuple[str | None, dict, list[dict], dict, str | None]:
    settings = db.get_settings()
    synced_at, cache_payload = db.get_sync_cache()
    raw_items = cache_payload.get("items") or []
    zero_items = cache_payload.get("zero_value_items")
    zero_scanned = int(cache_payload.get("zero_value_scanned") or 0)
    sync_error = None

    # On a fresh colleague PC install, warm-seed cache from bundled snapshot.json so UI loads instantly
    if not raw_items:
        snap_path = os.path.join(RESOURCE_DIR, "snapshot.json")
        if os.path.isfile(snap_path):
            try:
                with open(snap_path, "r", encoding="utf-8") as f:
                    snap_data = json.load(f)
                if snap_data.get("items"):
                    raw_items = snap_data.get("items") or []
                    zero_items = snap_data.get("zero_value_items") or []
                    zero_scanned = int(snap_data.get("zero_value_scanned") or 0)
                    synced_at = snap_data.get("synced_at")
            except Exception:
                pass

    has_creds = bool(
        (settings.get("scoville_email") or "").strip()
        and (settings.get("scoville_password") or "").strip()
    )

    if not raw_items and auto_sync_if_empty and has_creds:
        try:
            synced_at, cache_payload, directory = perform_scoville_sync()
            raw_items = cache_payload.get("items") or []
            zero_items = cache_payload.get("zero_value_items") or []
            zero_scanned = int(cache_payload.get("zero_value_scanned") or 0)
        except Exception as exc:
            sync_error = str(exc)
            directory = db.get_directory()
    else:
        directory = db.get_directory()

    evaluation = evaluate_items_and_packets(
        raw_items=raw_items,
        directory=directory,
        settings=settings,
        as_of_iso=as_of,
        include_due_today=include_due_today,
        exclude_on_hold=exclude_on_hold,
        milestone_filter=milestone_filter,
        zero_value_items=zero_items or [],
        zero_value_scanned=zero_scanned,
        due_soon_days=due_soon_days,
    )
    return synced_at, evaluation, directory, settings, sync_error


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/state", methods=["GET"])
def api_state():
    as_of = request.args.get("as_of") or None
    inc_today = _parse_bool_arg(request.args.get("include_due_today"))
    exc_hold = _parse_bool_arg(request.args.get("exclude_on_hold"))
    ms_filter = request.args.get("milestone") or None
    try:
        due_soon_days = int(request.args.get("due_soon_days") or 7)
    except ValueError:
        due_soon_days = 7

    synced_at, evaluation, directory, settings, sync_error = _build_current_evaluation(
        as_of=as_of,
        include_due_today=inc_today,
        exclude_on_hold=exc_hold,
        milestone_filter=ms_filter,
        auto_sync_if_empty=False,
        due_soon_days=due_soon_days,
    )
    needs_creds = not bool(
        (settings.get("scoville_email") or "").strip()
        and (settings.get("scoville_password") or "").strip()
    )
    return jsonify(
        {
            "ok": True,
            "app_version": 13,
            "today": date.today().isoformat(),
            "synced_at": synced_at,
            "sync_error": sync_error,
            "needs_credentials": needs_creds,
            "milestones": TRACKED_MILESTONES,
            "evaluation": evaluation,
            "directory": directory,
            "settings": settings,
            "effective_sender": resolve_effective_sender(settings),
            "logs": db.get_email_logs(limit=50),
        }
    )


@app.route("/api/sync", methods=["POST"])
def api_sync():
    payload = request.get_json(silent=True) or {}
    as_of = payload.get("as_of") or None
    inc_today = payload.get("include_due_today")
    exc_hold = payload.get("exclude_on_hold")
    ms_filter = payload.get("milestone") or None
    try:
        due_soon_days = int(payload.get("due_soon_days") or 7)
    except (TypeError, ValueError):
        due_soon_days = 7

    try:
        synced_at, cache_payload, directory = perform_scoville_sync()
        settings = db.get_settings()
        evaluation = evaluate_items_and_packets(
            raw_items=cache_payload.get("items") or [],
            directory=directory,
            settings=settings,
            as_of_iso=as_of,
            include_due_today=inc_today,
            exclude_on_hold=exc_hold,
            milestone_filter=ms_filter,
            zero_value_items=cache_payload.get("zero_value_items") or [],
            zero_value_scanned=int(cache_payload.get("zero_value_scanned") or 0),
            due_soon_days=due_soon_days,
        )
        return jsonify(
            {
                "ok": True,
                "synced_at": synced_at,
                "evaluation": evaluation,
                "directory": directory,
            }
        )
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/api/preview", methods=["POST"])
def api_preview():
    payload = request.get_json(silent=True) or {}
    packet_id = payload.get("packet_id")
    as_of = payload.get("as_of") or None
    inc_today = payload.get("include_due_today")
    exc_hold = payload.get("exclude_on_hold")
    ms_filter = payload.get("milestone") or None

    _, evaluation, _, settings, _ = _build_current_evaluation(
        as_of=as_of,
        include_due_today=inc_today,
        exclude_on_hold=exc_hold,
        milestone_filter=ms_filter,
        auto_sync_if_empty=False,
    )
    packet = next((p for p in evaluation["packets"] if p["packet_id"] == packet_id), None)
    if not packet:
        return jsonify({"ok": False, "error": "Packet not found for current filters."}), 404

    subj = (
        settings.get("zero_value_subject", "$0 Items on Scoville")
        if packet.get("packet_kind") == "zero_value"
        else settings.get("email_subject", "Overdues on Scoville")
    )
    html_body, plain_text = render_packet_email(packet, settings, evaluation["as_of_display"])
    return jsonify(
        {
            "ok": True,
            "packet_id": packet["packet_id"],
            "recipient_name": packet["recipient_name"],
            "from_email": resolve_effective_sender(settings),
            "to_emails": packet["to_emails"],
            "cc_emails": _parse_email_list(settings.get("cc_emails", "")),
            "subject": subj,
            "html_body": html_body,
            "plain_text": plain_text,
        }
    )


@app.route("/api/send", methods=["POST"])
def api_send():
    payload = request.get_json(silent=True) or {}
    packet_ids = payload.get("packet_ids")  # list[str] or "all"
    override_mode = payload.get("override_mode") or None
    as_of = payload.get("as_of") or None
    inc_today = payload.get("include_due_today")
    exc_hold = payload.get("exclude_on_hold")
    ms_filter = payload.get("milestone") or None

    _, evaluation, _, settings, _ = _build_current_evaluation(
        as_of=as_of,
        include_due_today=inc_today,
        exclude_on_hold=exc_hold,
        milestone_filter=ms_filter,
        auto_sync_if_empty=False,
    )

    all_packets = evaluation["packets"]
    if packet_ids == "all":
        selected = all_packets
    elif isinstance(packet_ids, list):
        wanted = set(packet_ids)
        selected = [p for p in all_packets if p["packet_id"] in wanted]
    else:
        return jsonify({"ok": False, "error": "Provide packet_ids list or 'all'."}), 400

    if not selected:
        return jsonify({"ok": False, "error": "No email packets matched to send."}), 400

    cc_emails = _parse_email_list(settings.get("cc_emails", ""))
    used_mode = override_mode or settings.get("delivery_mode", "outlook_send")

    results = []
    sent_count = 0
    error_count = 0

    for pkt in selected:
        subj = (
            settings.get("zero_value_subject", "$0 Items on Scoville")
            if pkt.get("packet_kind") == "zero_value"
            else settings.get("email_subject", "Overdues on Scoville")
        )
        html_body, plain_text = render_packet_email(pkt, settings, evaluation["as_of_display"])
        status, err_msg, actual_from = deliver_email(
            settings=settings,
            to_emails=pkt["to_emails"],
            subject=subj,
            html_body=html_body,
            plain_text=plain_text,
            override_mode=used_mode,
        )
        log_id = db.add_email_log(
            recipient_label=pkt["recipient_name"],
            to_emails=pkt["to_emails"],
            cc_emails=cc_emails,
            from_email=actual_from,
            subject=subj,
            delivery_mode=used_mode,
            status=status,
            item_count=pkt["item_count"],
            qkeys=pkt["qkeys"],
            html_body=html_body,
            error_message=err_msg,
        )
        if status == "error":
            error_count += 1
        else:
            sent_count += 1
        results.append(
            {
                "log_id": log_id,
                "packet_id": pkt["packet_id"],
                "recipient_name": pkt["recipient_name"],
                "to_emails": pkt["to_emails"],
                "status": status,
                "error": err_msg,
            }
        )

    return jsonify(
        {
            "ok": error_count == 0,
            "sent_count": sent_count,
            "error_count": error_count,
            "delivery_mode": used_mode,
            "results": results,
            "logs": db.get_email_logs(limit=50),
        }
    )


@app.route("/api/send-test", methods=["POST"])
def api_send_test():
    """Sends a sample Overdues on Scoville email to verify delivery configuration."""
    payload = request.get_json(silent=True) or {}
    settings = db.get_settings()
    test_to = (payload.get("to_email") or settings.get("default_recipient_email") or "akanday@qiworks.com").strip()
    override_mode = payload.get("override_mode") or settings.get("delivery_mode", "outlook_send")
    scoville_base = (settings.get("scoville_url") or "http://scoville:7555").rstrip("/")

    sample_packet = {
        "packet_id": "test:akash",
        "recipient_name": "Akash (DPM & PS Sample Test)",
        "person_name": "Akash",
        "role": "DPM",
        "to_emails": [test_to],
        "item_count": 1,
        "qkeys": ["22834"],
        "items": [
            {
                "qkey": "22834",
                "job_number": "46012",
                "job_site": "OHT - LBJ (SAMPLE TEST)",
                "category": "04 Ornamental",
                "sub_category": "Building Access Gate & Hardware with Side Panels",
                "sequence": "S0",
                "dpm": "Akash",
                "ps": "Jerrell",
                "edit_url": f"{scoville_base}/item/22834/edit",
                "relevant_milestones": [
                    {
                        "key": "dwg_complete",
                        "label": "DWG Complete",
                        "display": "11/15/2026",
                        "days_overdue": 2,
                        "is_field_dims": False,
                    },
                    {
                        "key": "fm",
                        "label": "Field Measurements",
                        "display": "11/14/2026",
                        "days_overdue": 3,
                        "is_field_dims": True,
                    },
                ],
            }
        ],
    }

    subject = settings.get("email_subject", "Overdues on Scoville")
    cc_emails = _parse_email_list(settings.get("cc_emails", ""))
    html_body, plain_text = render_packet_email(sample_packet, settings, date.today().strftime("%m/%d/%Y"))

    status, err_msg, actual_from = deliver_email(
        settings=settings,
        to_emails=[test_to],
        subject=subject,
        html_body=html_body,
        plain_text=plain_text,
        override_mode=override_mode,
    )
    log_id = db.add_email_log(
        recipient_label="TEST EMAIL — Akash",
        to_emails=[test_to],
        cc_emails=cc_emails,
        from_email=actual_from,
        subject=subject,
        delivery_mode=override_mode,
        status=status,
        item_count=1,
        qkeys=["22834"],
        html_body=html_body,
        error_message=err_msg,
    )
    return jsonify(
        {
            "ok": status != "error",
            "status": status,
            "error": err_msg,
            "log_id": log_id,
            "to_email": test_to,
            "delivery_mode": override_mode,
            "logs": db.get_email_logs(limit=50),
        }
    )


@app.route("/api/directory", methods=["PUT"])
def api_update_directory():
    payload = request.get_json(silent=True) or {}
    entries = payload.get("entries")
    if isinstance(entries, list):
        updated = db.bulk_update_directory(entries)
        synced_at, cache_payload = db.get_sync_cache()
        write_public_snapshot(synced_at, cache_payload, updated)
        return jsonify({"ok": True, "directory": updated})
    return jsonify({"ok": False, "error": "Expected 'entries' array."}), 400


@app.route("/api/settings", methods=["PUT"])
def api_update_settings():
    payload = request.get_json(silent=True) or {}
    updated = db.update_settings(payload)
    return jsonify({"ok": True, "settings": updated})


@app.route("/api/logs", methods=["GET"])
def api_logs():
    return jsonify({"ok": True, "logs": db.get_email_logs(limit=100)})


@app.route("/api/logs", methods=["DELETE"])
def api_clear_logs():
    scope = (request.args.get("scope") or "all").strip().lower()
    deleted = db.clear_email_logs(errors_only=(scope == "errors"))
    return jsonify({"ok": True, "deleted": deleted, "logs": db.get_email_logs(limit=100)})


@app.route("/api/logs/<int:log_id>", methods=["GET"])
def api_log_detail(log_id: int):
    detail = db.get_email_log_detail(log_id)
    if not detail:
        return jsonify({"ok": False, "error": "Log entry not found."}), 404
    return jsonify({"ok": True, "log": detail})


@app.route("/api/logs/<int:log_id>", methods=["DELETE"])
def api_delete_log(log_id: int):
    db.delete_email_log(log_id)
    return jsonify({"ok": True, "logs": db.get_email_logs(limit=100)})


def _scheduler_loop() -> None:
    """Background daily auto-send loop."""
    while True:
        try:
            settings = db.get_settings()
            if settings.get("schedule_enabled"):
                now = datetime.now()
                today_iso = now.date().isoformat()
                weekdays_only = bool(settings.get("schedule_weekdays_only", True))
                is_valid_day = (now.weekday() < 5) if weekdays_only else True

                sched_time = (settings.get("schedule_time") or "08:00").strip()
                now_hm = now.strftime("%H:%M")

                if is_valid_day and now_hm >= sched_time and settings.get("last_auto_run_date") != today_iso:
                    # Mark run date first to avoid duplicate firing
                    db.update_settings({"last_auto_run_date": today_iso})
                    _, cache_payload, directory = perform_scoville_sync()
                    settings = db.get_settings()
                    evaluation = evaluate_items_and_packets(
                        raw_items=cache_payload.get("items") or [],
                        directory=directory,
                        settings=settings,
                        as_of_iso=today_iso,
                    )
                    subject = settings.get("email_subject", "Overdues on Scoville")
                    cc_emails = _parse_email_list(settings.get("cc_emails", ""))
                    mode = settings.get("delivery_mode", "outlook_send")

                    for pkt in evaluation["packets"]:
                        html_body, plain_text = render_packet_email(pkt, settings, evaluation["as_of_display"])
                        status, err_msg, actual_from = deliver_email(
                            settings=settings,
                            to_emails=pkt["to_emails"],
                            subject=subject,
                            html_body=html_body,
                            plain_text=plain_text,
                            override_mode=mode,
                        )
                        db.add_email_log(
                            recipient_label=f"[Auto] {pkt['recipient_name']}",
                            to_emails=pkt["to_emails"],
                            cc_emails=cc_emails,
                            from_email=actual_from,
                            subject=subject,
                            delivery_mode=mode,
                            status=status,
                            item_count=pkt["item_count"],
                            qkeys=pkt["qkeys"],
                            html_body=html_body,
                            error_message=err_msg,
                        )
        except Exception:
            pass
        time.sleep(30)


@app.route("/api/eml", methods=["POST"])
def api_eml():
    """Returns an RFC-822 .eml message with X-Unsent: 1 so any remote PC opens it in its own local Outlook."""
    payload = request.get_json(silent=True) or {}
    packet_id = payload.get("packet_id")
    as_of = payload.get("as_of") or None
    inc_today = payload.get("include_due_today")
    exc_hold = payload.get("exclude_on_hold")
    ms_filter = payload.get("milestone") or None

    _, evaluation, _, settings, _ = _build_current_evaluation(
        as_of=as_of,
        include_due_today=inc_today,
        exclude_on_hold=exc_hold,
        milestone_filter=ms_filter,
        auto_sync_if_empty=False,
    )
    packet = next((p for p in evaluation["packets"] if p["packet_id"] == packet_id), None)
    if not packet:
        return jsonify({"ok": False, "error": "Packet not found for current filters."}), 404

    subj = (
        settings.get("zero_value_subject", "$0 Items on Scoville")
        if packet.get("packet_kind") == "zero_value"
        else settings.get("email_subject", "Overdues on Scoville")
    )
    cc_emails = _parse_email_list(settings.get("cc_emails", ""))
    html_body, plain_text = render_packet_email(packet, settings, evaluation["as_of_display"])

    msg = EmailMessage()
    msg["X-Unsent"] = "1"
    msg["Subject"] = subj
    msg["To"] = ", ".join(packet["to_emails"])
    if cc_emails:
        msg["Cc"] = ", ".join(cc_emails)
    msg.set_content(plain_text)
    msg.add_alternative(html_body, subtype="html")

    db.add_email_log(
        recipient_label=packet["recipient_name"],
        to_emails=packet["to_emails"],
        cc_emails=cc_emails,
        from_email="Client PC Local Outlook (.eml)",
        subject=subj,
        delivery_mode="client_outlook_eml",
        status="draft_saved",
        item_count=packet["item_count"],
        qkeys=packet["qkeys"],
        html_body=html_body,
    )

    safe_name = re.sub(r"[^A-Za-z0-9_-]+", "_", packet.get("person_name") or "Recipient")
    filename = f"Scoville_{safe_name}.eml"
    return Response(
        msg.as_bytes(),
        mimetype="message/rfc822",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def start_background_scheduler() -> None:
    t = threading.Thread(target=_scheduler_loop, daemon=True, name="ScovilleAutoMailer")
    t.start()


if __name__ == "__main__":
    db.init_db()
    start_background_scheduler()
    if IS_FROZEN:
        threading.Timer(1.2, lambda: webbrowser.open("http://127.0.0.1:5055")).start()
    app.run(host="127.0.0.1", port=5055, debug=False, threaded=True)

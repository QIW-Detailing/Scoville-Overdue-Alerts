from __future__ import annotations

import html
import json
import os
import smtplib
import subprocess
import tempfile
from email.message import EmailMessage
from email.utils import formataddr


TNR = "font-family:'Times New Roman',Times,serif;"


def _group_items_by_job(items: list[dict]) -> list[tuple[str, list[dict]]]:
    groups: dict[str, list[dict]] = {}
    order: list[str] = []
    for it in items:
        j_num = (it.get("job_number") or "").strip()
        j_site = (it.get("job_site") or "").strip()
        label = f"Job {j_num} — {j_site}".strip(" —") if j_num else (j_site or "General")
        if label not in groups:
            groups[label] = []
            order.append(label)
        groups[label].append(it)
    return [(lbl, groups[lbl]) for lbl in order]


def _outlook_button(href: str, text: str, bg_color: str = "#991b1b") -> str:
    """Renders a 1-cell table button so Classic Outlook (Word HTML) honors cell padding."""
    return (
        f'<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto;">'
        f"<tr>"
        f'<td bgcolor="{bg_color}" style="background:{bg_color};padding:6px 14px;border:1px solid {bg_color};text-align:center;{TNR}">'
        f'<a href="{href}" style="{TNR}font-size:11pt;font-weight:bold;color:#ffffff;text-decoration:none;display:inline-block;">'
        f"{text}"
        f"</a>"
        f"</td>"
        f"</tr>"
        f"</table>"
    )


def render_packet_email(packet: dict, settings: dict, as_of_display: str) -> tuple[str, str]:
    """Returns (html_body, plain_text_body) in clean, organized Times New Roman for Outlook."""
    if packet.get("packet_kind") == "zero_value":
        return _render_zero_value_packet_email(packet, settings, as_of_display)
    if packet.get("packet_kind") == "missing_bom":
        return _render_missing_bom_packet_email(packet, settings, as_of_display)

    recipient_label = packet.get("recipient_name", "Team")
    person_name = packet.get("person_name") or recipient_label.split("(")[0].strip() or "Team"
    role = packet.get("role", "DPM")
    items = packet.get("items", [])
    scoville_base = (settings.get("scoville_url") or "http://scoville:7555").rstrip("/")

    is_ps_only = role.startswith("PS")
    intro_text = (
        f"The following Scoville items have past-due Field Measurements or PS Request dates as of {as_of_display}. "
        "Please review these items and update the dates in Scoville."
        if is_ps_only
        else f"The following Scoville schedule dates are past due as of {as_of_display}. "
        "Please open each item below and update the missed dates (or check off milestones that are already completed)."
    )

    grouped_jobs = _group_items_by_job(items)
    rows_html: list[str] = []
    plain_lines = [
        f"Hi {person_name},",
        "",
        "OVERDUES ON SCOVILLE",
        f"Assigned To: {recipient_label} | Total Items: {len(items)} | Date: {as_of_display}",
        intro_text,
        "",
    ]

    for job_title, job_items in grouped_jobs:
        cnt_word = f"{len(job_items)} item" if len(job_items) == 1 else f"{len(job_items)} items"
        rows_html.append(
            f'<tr>'
            f'<td colspan="5" bgcolor="#e2e8f0" style="{TNR}background:#e2e8f0;padding:8px 12px;'
            f'border:1px solid #cbd5e1;font-size:11.5pt;font-weight:bold;color:#0f172a;">'
            f"{html.escape(job_title)} "
            f'<span style="{TNR}font-size:10.5pt;font-weight:normal;color:#334155;">({cnt_word})</span>'
            f"</td>"
            f"</tr>"
        )
        plain_lines.append(f"=== {job_title} ({cnt_word}) ===")

        for idx, it in enumerate(job_items):
            bg = "#ffffff" if idx % 2 == 0 else "#f8fafc"
            qkey = html.escape(str(it.get("qkey", "")))
            edit_url = html.escape(it.get("edit_url") or f"{scoville_base}/item/{qkey}/edit")
            cat_line = it.get("category", "")
            sub_line = it.get("sub_category", "")
            seq = it.get("sequence", "")
            dpm = it.get("dpm", "")
            ps = it.get("ps", "")

            milestones = it.get("relevant_milestones") or it.get("overdue_milestones") or []
            ms_lines_html: list[str] = []
            plain_ms: list[str] = []

            for m_idx, m in enumerate(milestones):
                days = m.get("days_overdue") or 0
                overdue_tag = "Due Today" if days == 0 else f"{days} days overdue"
                m_label = html.escape(m.get("label", ""))
                m_date = html.escape(m.get("display", ""))
                is_ps_shared = bool(m.get("is_field_dims"))
                color = "#9a3412" if is_ps_shared else "#991b1b"
                top_pad = "padding-top:5px;" if m_idx > 0 else ""

                ms_lines_html.append(
                    f'<div style="{TNR}{top_pad}font-size:11pt;line-height:1.4;color:#0f172a;">'
                    f"&bull; <strong>{m_label}:</strong> {m_date} "
                    f'<span style="{TNR}color:{color};font-weight:bold;">({overdue_tag})</span>'
                    f"</div>"
                )
                plain_ms.append(f"{m.get('label')}: {m.get('display')} ({overdue_tag})")

            desc_parts = []
            if cat_line:
                desc_parts.append(f'<strong style="{TNR}color:#0f172a;">{html.escape(cat_line)}</strong>')
            if sub_line:
                desc_parts.append(f'<span style="{TNR}color:#334155;">{html.escape(sub_line)}</span>')
            if seq:
                desc_parts.append(f'<span style="{TNR}color:#475569;font-size:10pt;">Sequence: {html.escape(seq)}</span>')
            scope_html = "<br>".join(desc_parts) or "—"

            rows_html.append(
                f'<tr bgcolor="{bg}" style="background:{bg};">'
                f'<td width="72" align="center" valign="top" style="{TNR}padding:9px 10px;border:1px solid #cbd5e1;font-size:11.5pt;font-weight:bold;">'
                f'<a href="{edit_url}" style="{TNR}color:#1d4ed8;text-decoration:underline;">{qkey}</a>'
                f"</td>"
                f'<td valign="top" style="{TNR}padding:9px 12px;border:1px solid #cbd5e1;font-size:11pt;line-height:1.4;">'
                f"{scope_html}"
                f"</td>"
                f'<td width="135" valign="top" style="{TNR}padding:9px 12px;border:1px solid #cbd5e1;font-size:11pt;line-height:1.4;color:#1e293b;">'
                f"<strong>DPM:</strong> {html.escape(dpm)}<br>"
                f"<strong>PS:</strong> {html.escape(ps)}"
                f"</td>"
                f'<td valign="top" style="{TNR}padding:9px 12px;border:1px solid #cbd5e1;font-size:11pt;">'
                f'{"".join(ms_lines_html)}'
                f"</td>"
                f'<td width="122" align="center" valign="middle" style="{TNR}padding:9px 10px;border:1px solid #cbd5e1;">'
                f'{_outlook_button(edit_url, "Update Dates", "#991b1b")}'
                f"</td>"
                f"</tr>"
            )

            plain_lines.append(f"  - QKEY {it.get('qkey')} | {cat_line} - {sub_line} (DPM: {dpm}, PS: {ps})")
            plain_lines.append(f"    Missed: {'; '.join(plain_ms)}")
            plain_lines.append(f"    Link: {it.get('edit_url')}")
        plain_lines.append("")

    plain_text = "\n".join(plain_lines)

    html_body = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Overdues on Scoville</title>
  <style type="text/css">
    body, table, td, th, p, div, a, span {{
      font-family: 'Times New Roman', Times, serif !important;
    }}
  </style>
</head>
<body style="margin:0;padding:18px;background-color:#f8fafc;{TNR}color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:920px;margin:0 auto;background:#ffffff;border:1px solid #94a3b8;border-collapse:collapse;">
    <tr>
      <td bgcolor="#7f1d1d" style="background:#7f1d1d;color:#ffffff;padding:14px 20px;{TNR}border-bottom:2px solid #450a0a;">
        <div style="{TNR}font-size:15pt;font-weight:bold;color:#ffffff;">Scoville Overdue Schedule Report</div>
        <div style="{TNR}font-size:11pt;color:#fecaca;margin-top:3px;">
          Assigned To: <strong>{html.escape(recipient_label)}</strong> &nbsp;&bull;&nbsp;
          Overdue Items: <strong>{len(items)}</strong> &nbsp;&bull;&nbsp;
          Report Date: <strong>{html.escape(as_of_display)}</strong>
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 20px 12px 20px;{TNR}font-size:12pt;line-height:1.5;color:#0f172a;">
        <p style="margin:0 0 8px 0;{TNR}font-size:12pt;">Hi <strong>{html.escape(person_name)}</strong>,</p>
        <p style="margin:0;{TNR}font-size:12pt;">{html.escape(intro_text)}</p>
      </td>
    </tr>
    <tr>
      <td style="padding:4px 20px 18px 20px;{TNR}">
        <table width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;border:1px solid #cbd5e1;{TNR}">
          <thead>
            <tr bgcolor="#f1f5f9" style="background:#f1f5f9;">
              <th width="72" align="center" style="{TNR}padding:8px 10px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">QKEY</th>
              <th align="left" style="{TNR}padding:8px 12px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">Category / Description</th>
              <th width="135" align="left" style="{TNR}padding:8px 12px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">DPM / PS</th>
              <th align="left" style="{TNR}padding:8px 12px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">Missed Date(s)</th>
              <th width="122" align="center" style="{TNR}padding:8px 10px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">Scoville</th>
            </tr>
          </thead>
          <tbody>
            {"".join(rows_html)}
          </tbody>
        </table>
      </td>
    </tr>
    <tr>
      <td bgcolor="#f8fafc" style="background:#f8fafc;border-top:1px solid #cbd5e1;padding:10px 20px;{TNR}font-size:10pt;color:#475569;">
        Tracked dates: Field Measurements (DPM &amp; PS), DWG Complete, Engineer Calcs, Approval Submittal, Release to Shop, and PS Request (unlinked to Tekla). Approvals and Shop/Shipping dates are excluded.
      </td>
    </tr>
  </table>
</body>
</html>"""

    return html_body, plain_text


def _render_zero_value_packet_email(packet: dict, settings: dict, as_of_display: str) -> tuple[str, str]:
    recipient_label = packet.get("recipient_name", "DPM")
    person_name = packet.get("person_name") or recipient_label.split("(")[0].strip() or "Team"
    items = packet.get("items", [])
    scoville_base = (settings.get("scoville_url") or "http://scoville:7555").rstrip("/")

    grouped_jobs = _group_items_by_job(items)
    rows_html: list[str] = []
    plain_lines = [
        f"Hi {person_name},",
        "",
        "$0 ITEMS ON SCOVILLE — PLEASE ASSIGN SCOPE ITEM VALUES",
        f"Assigned DPM: {person_name} | Total $0 Items: {len(items)} | Date: {as_of_display}",
        "",
    ]

    for job_title, job_items in grouped_jobs:
        cnt_word = f"{len(job_items)} item" if len(job_items) == 1 else f"{len(job_items)} items"
        rows_html.append(
            f'<tr>'
            f'<td colspan="4" bgcolor="#e2e8f0" style="{TNR}background:#e2e8f0;padding:8px 12px;'
            f'border:1px solid #cbd5e1;font-size:11.5pt;font-weight:bold;color:#0f172a;">'
            f"{html.escape(job_title)} "
            f'<span style="{TNR}font-size:10.5pt;font-weight:normal;color:#334155;">({cnt_word})</span>'
            f"</td>"
            f"</tr>"
        )
        plain_lines.append(f"=== {job_title} ({cnt_word}) ===")

        for idx, it in enumerate(job_items):
            bg = "#ffffff" if idx % 2 == 0 else "#f8fafc"
            qkey = html.escape(str(it.get("qkey", "")))
            forecast_url = html.escape(it.get("forecast_url") or f"{scoville_base}/item/{qkey}/forecastValues")
            cat_line = it.get("category", "")
            sub_line = it.get("sub_category", "")
            seq = it.get("sequence", "")
            rel_status = it.get("release_status") or ("Released" if it.get("released") else "Unreleased")
            scope_cnt = it.get("available_scope_count", 0)
            samples = it.get("sample_scope_options") or []

            desc_parts = []
            if cat_line:
                desc_parts.append(f'<strong style="{TNR}color:#0f172a;">{html.escape(cat_line)}</strong>')
            if sub_line:
                desc_parts.append(f'<span style="{TNR}color:#334155;">{html.escape(sub_line)}</span>')
            if seq:
                desc_parts.append(f'<span style="{TNR}color:#475569;font-size:10pt;">Sequence: {html.escape(seq)}</span>')
            scope_html = "<br>".join(desc_parts) or "—"

            sample_html = ""
            if samples:
                sample_preview = "; ".join(html.escape(s) for s in samples[:3])
                more = f" (+{scope_cnt - 3} more)" if scope_cnt > 3 else ""
                sample_html = f'<div style="{TNR}font-size:10.5pt;color:#475569;margin-top:3px;">Examples: {sample_preview}{more}</div>'

            rows_html.append(
                f'<tr bgcolor="{bg}" style="background:{bg};">'
                f'<td width="95" align="center" valign="top" style="{TNR}padding:9px 10px;border:1px solid #cbd5e1;font-size:11.5pt;font-weight:bold;">'
                f'<a href="{forecast_url}" style="{TNR}color:#1e3a8a;text-decoration:underline;">{qkey}</a>'
                f'<div style="{TNR}font-size:10pt;color:#475569;font-weight:normal;margin-top:2px;">{html.escape(rel_status)}</div>'
                f"</td>"
                f'<td valign="top" style="{TNR}padding:9px 12px;border:1px solid #cbd5e1;font-size:11pt;line-height:1.4;">'
                f"{scope_html}"
                f"</td>"
                f'<td valign="top" style="{TNR}padding:9px 12px;border:1px solid #cbd5e1;font-size:11pt;line-height:1.4;">'
                f'<strong style="{TNR}color:#1e3a8a;">Current Value: $0.00</strong> &mdash; '
                f"{scope_cnt} scope item{'s' if scope_cnt != 1 else ''} available to assign"
                f"{sample_html}"
                f"</td>"
                f'<td width="122" align="center" valign="middle" style="{TNR}padding:9px 10px;border:1px solid #cbd5e1;">'
                f'{_outlook_button(forecast_url, "Assign Value", "#1e3a8a")}'
                f"</td>"
                f"</tr>"
            )

            plain_lines.append(f"  - QKEY {it.get('qkey')} ({rel_status}) | {scope_cnt} scope items available | {it.get('forecast_url')}")
        plain_lines.append("")

    plain_text = "\n".join(plain_lines)
    html_body = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>$0 Items on Scoville</title>
  <style type="text/css">
    body, table, td, th, p, div, a, span {{
      font-family: 'Times New Roman', Times, serif !important;
    }}
  </style>
</head>
<body style="margin:0;padding:18px;background-color:#f8fafc;{TNR}color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:920px;margin:0 auto;background:#ffffff;border:1px solid #94a3b8;border-collapse:collapse;">
    <tr>
      <td bgcolor="#1e3a8a" style="background:#1e3a8a;color:#ffffff;padding:14px 20px;{TNR}border-bottom:2px solid #172554;">
        <div style="{TNR}font-size:15pt;font-weight:bold;color:#ffffff;">Scoville $0 Items Report &mdash; Assign Scope Values</div>
        <div style="{TNR}font-size:11pt;color:#dbeafe;margin-top:3px;">
          Assigned DPM: <strong>{html.escape(person_name)}</strong> &nbsp;&bull;&nbsp;
          $0 Items: <strong>{len(items)}</strong> &nbsp;&bull;&nbsp;
          Report Date: <strong>{html.escape(as_of_display)}</strong>
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 20px 12px 20px;{TNR}font-size:12pt;line-height:1.5;color:#0f172a;">
        <p style="margin:0 0 8px 0;{TNR}font-size:12pt;">Hi <strong>{html.escape(person_name)}</strong>,</p>
        <p style="margin:0;{TNR}font-size:12pt;">
          The following Scoville items are still at <strong>$0.00</strong> even though job-specific Scope Items &amp; Values are available in the dropdown.
          Please open each item below and assign its value in Scoville.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:4px 20px 18px 20px;{TNR}">
        <table width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;border:1px solid #cbd5e1;{TNR}">
          <thead>
            <tr bgcolor="#f1f5f9" style="background:#f1f5f9;">
              <th width="95" align="center" style="{TNR}padding:8px 10px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">QKEY / Status</th>
              <th align="left" style="{TNR}padding:8px 12px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">Category / Description</th>
              <th align="left" style="{TNR}padding:8px 12px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">Available Scope Items</th>
              <th width="122" align="center" style="{TNR}padding:8px 10px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">Scoville</th>
            </tr>
          </thead>
          <tbody>
            {"".join(rows_html)}
          </tbody>
        </table>
      </td>
    </tr>
    <tr>
      <td bgcolor="#f8fafc" style="background:#f8fafc;border-top:1px solid #cbd5e1;padding:10px 20px;{TNR}font-size:10pt;color:#475569;">
        Items where only the 3 default placeholder options ($1 Unbillable, $2 Unwritten CO, $3 Unapproved CO) exist are automatically skipped.
      </td>
    </tr>
  </table>
</body>
</html>"""
    return html_body, plain_text


def _render_missing_bom_packet_email(packet: dict, settings: dict, as_of_display: str) -> tuple[str, str]:
    recipient_label = packet.get("recipient_name", "DPM")
    person_name = packet.get("person_name") or recipient_label.split("(")[0].strip() or "Team"
    items = packet.get("items", [])
    scoville_base = (settings.get("scoville_url") or "http://scoville:7555").rstrip("/")
    grace_h = settings.get("bom_grace_hours") or 2

    grouped_jobs = _group_items_by_job(items)
    rows_html: list[str] = []
    plain_lines = [
        f"Hi {person_name},",
        "",
        f"MISSING BOM EMAIL — TEKLA-LINKED OVER {grace_h} HOURS WITHOUT BOM TRANSMITTAL",
        f"Assigned DPM: {person_name} | Total Missing BOM Items: {len(items)} | Date: {as_of_display}",
        "",
    ]

    for job_title, job_items in grouped_jobs:
        cnt_word = f"{len(job_items)} item" if len(job_items) == 1 else f"{len(job_items)} items"
        rows_html.append(
            f'<tr>'
            f'<td colspan="4" bgcolor="#e2e8f0" style="{TNR}background:#e2e8f0;padding:8px 12px;'
            f'border:1px solid #cbd5e1;font-size:11.5pt;font-weight:bold;color:#0f172a;">'
            f"{html.escape(job_title)} "
            f'<span style="{TNR}font-size:10.5pt;font-weight:normal;color:#334155;">({cnt_word})</span>'
            f"</td>"
            f"</tr>"
        )
        plain_lines.append(f"=== {job_title} ({cnt_word}) ===")

        for idx, it in enumerate(job_items):
            bg = "#ffffff" if idx % 2 == 0 else "#f8fafc"
            qkey = html.escape(str(it.get("qkey", "")))
            edit_url = html.escape(it.get("edit_url") or f"{scoville_base}/item/{qkey}/edit")
            lot_num = html.escape(str(it.get("lot_number", "")))
            cat_line = it.get("category", "")
            sub_line = it.get("sub_category", "")
            seq = it.get("sequence", "")
            linked_disp = html.escape(str(it.get("linked_display", "—")))
            elapsed_disp = html.escape(str(it.get("elapsed_display", "")))

            desc_parts = []
            if cat_line:
                desc_parts.append(f'<strong style="{TNR}color:#0f172a;">{html.escape(cat_line)}</strong>')
            if sub_line:
                desc_parts.append(f'<span style="{TNR}color:#334155;">{html.escape(sub_line)}</span>')
            if seq:
                desc_parts.append(f'<span style="{TNR}color:#475569;font-size:10pt;">Sequence: {html.escape(seq)}</span>')
            scope_html = "<br>".join(desc_parts) or "—"

            rows_html.append(
                f'<tr bgcolor="{bg}" style="background:{bg};">'
                f'<td width="105" align="center" valign="top" style="{TNR}padding:9px 10px;border:1px solid #cbd5e1;font-size:11.5pt;font-weight:bold;">'
                f'<a href="{edit_url}" style="{TNR}color:#9a3412;text-decoration:underline;">{qkey}</a>'
                f'<div style="{TNR}font-size:10.5pt;color:#7c2d12;font-weight:bold;margin-top:2px;">Lot #{lot_num}</div>'
                f"</td>"
                f'<td valign="top" style="{TNR}padding:9px 12px;border:1px solid #cbd5e1;font-size:11pt;line-height:1.4;">'
                f"{scope_html}"
                f"</td>"
                f'<td valign="top" style="{TNR}padding:9px 12px;border:1px solid #cbd5e1;font-size:11pt;line-height:1.4;">'
                f"<strong>Linked to Tekla:</strong> {linked_disp}<br>"
                f'<span style="{TNR}color:#9a3412;font-weight:bold;">No BOM email found ({elapsed_disp})</span>'
                f"</td>"
                f'<td width="122" align="center" valign="middle" style="{TNR}padding:9px 10px;border:1px solid #cbd5e1;">'
                f'{_outlook_button(edit_url, "View Item", "#9a3412")}'
                f"</td>"
                f"</tr>"
            )

            plain_lines.append(
                f"  - QKEY {it.get('qkey')} | Lot #{it.get('lot_number')} | Linked: {it.get('linked_display')} ({it.get('elapsed_display')}) | {it.get('edit_url')}"
            )
        plain_lines.append("")

    plain_text = "\n".join(plain_lines)
    html_body = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Missing BOM Email</title>
  <style type="text/css">
    body, table, td, th, p, div, a, span {{
      font-family: 'Times New Roman', Times, serif !important;
    }}
  </style>
</head>
<body style="margin:0;padding:18px;background-color:#f8fafc;{TNR}color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:920px;margin:0 auto;background:#ffffff;border:1px solid #94a3b8;border-collapse:collapse;">
    <tr>
      <td bgcolor="#9a3412" style="background:#9a3412;color:#ffffff;padding:14px 20px;{TNR}border-bottom:2px solid #431407;">
        <div style="{TNR}font-size:15pt;font-weight:bold;color:#ffffff;">Missing BOM Transmittal Alert</div>
        <div style="{TNR}font-size:11pt;color:#ffedd5;margin-top:3px;">
          Assigned DPM: <strong>{html.escape(person_name)}</strong> &nbsp;&bull;&nbsp;
          Missing BOM Items: <strong>{len(items)}</strong> &nbsp;&bull;&nbsp;
          Report Date: <strong>{html.escape(as_of_display)}</strong>
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 20px 12px 20px;{TNR}font-size:12pt;line-height:1.5;color:#0f172a;">
        <p style="margin:0 0 8px 0;{TNR}font-size:12pt;">Hi <strong>{html.escape(person_name)}</strong>,</p>
        <p style="margin:0;{TNR}font-size:12pt;">
          The following items were linked to Tekla over <strong>{html.escape(str(grace_h))} hours</strong> ago, and no matching BOM transmittal email (by Job # &amp; Lot/FAB #) has been received in <strong>BOM@qiworks.com</strong> yet.
          Please send the BOM transmittal email to <strong>BOM@qiworks.com</strong>.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:4px 20px 18px 20px;{TNR}">
        <table width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;border:1px solid #cbd5e1;{TNR}">
          <thead>
            <tr bgcolor="#f1f5f9" style="background:#f1f5f9;">
              <th width="105" align="center" style="{TNR}padding:8px 10px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">QKEY / Lot #</th>
              <th align="left" style="{TNR}padding:8px 12px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">Category / Description</th>
              <th align="left" style="{TNR}padding:8px 12px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">Tekla Link Time</th>
              <th width="122" align="center" style="{TNR}padding:8px 10px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">Scoville</th>
            </tr>
          </thead>
          <tbody>
            {"".join(rows_html)}
          </tbody>
        </table>
      </td>
    </tr>
    <tr>
      <td bgcolor="#f8fafc" style="background:#f8fafc;border-top:1px solid #cbd5e1;padding:10px 20px;{TNR}font-size:10pt;color:#475569;">
        Matched by Job # and Transmittal / FAB Lot # (e.g. 45049 - Transmittal #F002) sent to BOM@qiworks.com.
      </td>
    </tr>
  </table>
</body>
</html>"""
    return html_body, plain_text


def _parse_email_list(raw: str | list[str]) -> list[str]:
    if isinstance(raw, list):
        parts = raw
    else:
        parts = (raw or "").replace(";", ",").split(",")
    cleaned = []
    for p in parts:
        e = p.strip()
        if e and e not in cleaned:
            cleaned.append(e)
    return cleaned


def _send_via_smtp(
    settings: dict,
    from_email: str,
    from_name: str,
    to_emails: list[str],
    cc_emails: list[str],
    subject: str,
    html_body: str,
    plain_text: str,
) -> None:
    host = (settings.get("smtp_host") or "").strip()
    port = int(settings.get("smtp_port") or 587)
    use_ssl = bool(settings.get("smtp_use_ssl", False))
    use_tls = bool(settings.get("smtp_use_tls", True))
    username = (settings.get("smtp_username") or "").strip()
    password = settings.get("smtp_password") or ""

    if not host:
        raise RuntimeError("SMTP Host is empty. Configure SMTP Host in Settings (or switch Delivery Mode to Outlook / Dry-Run).")

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((from_name, from_email)) if from_name else from_email
    msg["To"] = ", ".join(to_emails)
    if cc_emails:
        msg["Cc"] = ", ".join(cc_emails)
    msg.set_content(plain_text)
    msg.add_alternative(html_body, subtype="html")

    all_rcpts = to_emails + [c for c in cc_emails if c not in to_emails]

    if use_ssl:
        with smtplib.SMTP_SSL(host, port, timeout=25) as server:
            if username and password:
                server.login(username, password)
            server.send_message(msg, from_addr=from_email, to_addrs=all_rcpts)
    else:
        with smtplib.SMTP(host, port, timeout=25) as server:
            server.ehlo()
            if use_tls:
                server.starttls()
                server.ehlo()
            if username and password:
                server.login(username, password)
            server.send_message(msg, from_addr=from_email, to_addrs=all_rcpts)


_cached_outlook_account: str | None = None


def get_local_outlook_account() -> str:
    """Detects the primary signed-in email address from local Windows Microsoft Outlook."""
    global _cached_outlook_account
    if _cached_outlook_account is not None:
        return _cached_outlook_account

    ps = r"""
$ErrorActionPreference = 'SilentlyContinue'
$outlook = New-Object -ComObject Outlook.Application
if ($outlook -ne $null) {
    foreach ($acct in $outlook.Session.Accounts) {
        if ($acct.SmtpAddress) {
            Write-Output $acct.SmtpAddress
            exit 0
        }
    }
    $exUser = $outlook.Session.CurrentUser.AddressEntry.GetExchangeUser()
    if ($exUser -ne $null -and $exUser.PrimarySmtpAddress) {
        Write-Output $exUser.PrimarySmtpAddress
        exit 0
    }
}
"""
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True,
            text=True,
            timeout=10,
        )
        detected = (proc.stdout or "").strip().splitlines()
        if detected and "@" in detected[0]:
            _cached_outlook_account = detected[0].strip()
            return _cached_outlook_account
    except Exception:
        pass

    _cached_outlook_account = "Local Outlook"
    return _cached_outlook_account


def resolve_effective_sender(settings: dict) -> str:
    mode = (settings.get("delivery_mode") or "outlook_send").strip()
    configured_from = (settings.get("from_email") or "").strip()
    if mode.startswith("outlook"):
        if settings.get("outlook_send_on_behalf") and configured_from:
            return configured_from
        acct = get_local_outlook_account()
        return f"{acct} (Local Outlook)" if "@" in acct else "Local Outlook Account"
    return configured_from or (settings.get("smtp_username") or "Local Outlook").strip()


def _send_via_outlook(
    from_email: str,
    to_emails: list[str],
    cc_emails: list[str],
    subject: str,
    html_body: str,
    send_immediately: bool,
    use_sent_on_behalf: bool = False,
) -> str:
    """Sends or saves draft using whichever Outlook account is signed in on the local PC."""
    payload = {
        "from_email": from_email,
        "to": "; ".join(to_emails),
        "cc": "; ".join(cc_emails),
        "subject": subject,
        "html_body": html_body,
        "send": bool(send_immediately),
        "use_behalf": bool(use_sent_on_behalf),
    }

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as tmp:
        json.dump(payload, tmp)
        tmp_path = tmp.name

    ps_script = r"""
$ErrorActionPreference = 'Stop'
$jsonPath = $env:SCOVILLE_MAIL_JSON
$data = Get-Content -Raw -Encoding UTF8 -LiteralPath $jsonPath | ConvertFrom-Json
$outlook = New-Object -ComObject Outlook.Application
$senderAddr = ''
foreach ($acct in $outlook.Session.Accounts) {
    if ($acct.SmtpAddress) { $senderAddr = $acct.SmtpAddress; break }
}
$mail = $outlook.CreateItem(0)
$mail.To = [string]$data.to
if ($data.cc) { $mail.CC = [string]$data.cc }
$mail.Subject = [string]$data.subject
if ($data.use_behalf -and $data.from_email) {
    $matchedAcct = $null
    foreach ($acct in $outlook.Session.Accounts) {
        if ($acct.SmtpAddress -and ($acct.SmtpAddress.ToLower() -eq ([string]$data.from_email).ToLower())) {
            $matchedAcct = $acct
            break
        }
    }
    if ($matchedAcct -ne $null) {
        $mail.SendUsingAccount = $matchedAcct
        $senderAddr = $matchedAcct.SmtpAddress
    } else {
        $mail.SentOnBehalfOfName = [string]$data.from_email
        $senderAddr = [string]$data.from_email
    }
}
$mail.HTMLBody = [string]$data.html_body
if ($data.send) {
    $mail.Send()
} else {
    $mail.Save()
}
Write-Output $senderAddr
"""
    try:
        env = dict(os.environ)
        env["SCOVILLE_MAIL_JSON"] = tmp_path
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script],
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
        )
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "Outlook COM invocation failed").strip()
            raise RuntimeError(
                f"Outlook desktop automation error: {err}. "
                "Make sure Classic Microsoft Outlook is open/signed in on this computer."
            )
        lines = [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]
        return lines[-1] if lines else get_local_outlook_account()
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def deliver_email(
    settings: dict,
    to_emails: list[str],
    subject: str,
    html_body: str,
    plain_text: str,
    override_mode: str | None = None,
) -> tuple[str, str, str]:
    """
    Delivers email according to delivery_mode:
      - dry_run -> ("dry_run", "", sender)
      - outlook_draft -> ("draft_saved", "", sender)
      - outlook_send -> ("sent", "", sender)
      - smtp -> ("sent", "", sender)
    Returns (status, error_message, actual_sender).
    """
    mode = (override_mode or settings.get("delivery_mode") or "outlook_send").strip()
    configured_from = (settings.get("from_email") or "").strip()
    from_name = (settings.get("from_name") or "Scoville Detailing Alerts").strip()
    cc_emails = _parse_email_list(settings.get("cc_emails", ""))

    if mode == "dry_run":
        return "dry_run", "", resolve_effective_sender(settings)

    try:
        if mode == "smtp":
            smtp_sender = configured_from or (settings.get("smtp_username") or "").strip()
            if not smtp_sender:
                raise RuntimeError("SMTP mode requires a From Email or SMTP Username in Settings.")
            _send_via_smtp(
                settings=settings,
                from_email=smtp_sender,
                from_name=from_name,
                to_emails=to_emails,
                cc_emails=cc_emails,
                subject=subject,
                html_body=html_body,
                plain_text=plain_text,
            )
            return "sent", "", smtp_sender
        elif mode == "outlook_send":
            actual_from = _send_via_outlook(
                from_email=configured_from,
                to_emails=to_emails,
                cc_emails=cc_emails,
                subject=subject,
                html_body=html_body,
                send_immediately=True,
                use_sent_on_behalf=bool(settings.get("outlook_send_on_behalf", False)),
            )
            return "sent", "", actual_from or resolve_effective_sender(settings)
        elif mode == "outlook_draft":
            actual_from = _send_via_outlook(
                from_email=configured_from,
                to_emails=to_emails,
                cc_emails=cc_emails,
                subject=subject,
                html_body=html_body,
                send_immediately=False,
                use_sent_on_behalf=bool(settings.get("outlook_send_on_behalf", False)),
            )
            return "draft_saved", "", actual_from or resolve_effective_sender(settings)
        else:
            return "dry_run", "", resolve_effective_sender(settings)
    except Exception as exc:
        return "error", str(exc), resolve_effective_sender(settings)

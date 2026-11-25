from __future__ import annotations

import json
import os
import re
import subprocess
from datetime import datetime

import db


def extract_job_lot_pairs(
    subject: str,
    attachments: list[str] | None = None,
    body_snippet: str = "",
) -> list[tuple[str, str]]:
    """
    Extracts (job_number, lot_number) pairs from a BOM transmittal email.
    Examples matched:
      - '45049 - 805-711 Elm - Transmittal #F002 - 00 Embeds : Brick Relief Embeds' -> ('45049', 'F002')
      - '45035 - UTSW Ft. Worth Radiology - Transmittal #M005 - ...' -> ('45035', 'M005')
      - Attachment/body 'SR-45050-F201-REV1.pdf' or '45049-F002' -> ('45050', 'F201'), ('45049', 'F002')
    """
    pairs: list[tuple[str, str]] = []
    seen: set[str] = set()

    def _add(j: str, lot: str) -> None:
        key = db.normalize_job_lot_key(j, lot)
        if key not in seen:
            seen.add(key)
            _, canon_lot = key.split(":", 1)
            pairs.append((j.strip(), canon_lot))

    subj = subject or ""
    att_text = " ".join(attachments or [])
    combined_text = f"{subj}\n{att_text}\n{body_snippet or ''}"

    # 1) Explicit <5-digit Job #>-<Lot #> anywhere in subject, attachment filenames, or body (e.g. 45049-F002)
    for m in re.finditer(r"\b(\d{5})\s*[-_]\s*([FMRfmr]\d{1,4})\b", combined_text):
        _add(m.group(1), m.group(2))

    # 2) Subject containing a 5-digit Job # plus Transmittal #<Lot> or Lot #<Lot> or standalone F### / M### / R###
    subj_jobs = re.findall(r"\b(\d{5})\b", subj)
    if subj_jobs:
        primary_job = subj_jobs[0]
        # Explicit Transmittal / Lot / FAB tag (allows multiple e.g. 'Transmittal #F201 & #F202')
        for tm in re.finditer(r"(?:transmittal|lot|fab)\s*#?\s*([A-Za-z]{1,2}\d{1,4})\b", subj, flags=re.IGNORECASE):
            _add(primary_job, tm.group(1))
        # Standalone F###, M###, or R### tokens in subject or attachment names
        for fm in re.finditer(r"\b([FMRfmr]\d{2,4})\b", f"{subj} {att_text}"):
            _add(primary_job, fm.group(1))

    return pairs


def scan_outlook_bom_emails(since_iso: str = "2026-11-24", timeout_sec: int = 20) -> dict:
    """
    Read-only scan of local Microsoft Outlook:
      1) 'Detailing Mailbox' (or any store matching *Detailing* / *BOM*) -> Inbox, Sent Items, Deleted Items, Archive (+ subfolders)
      2) Local user's primary mailbox -> Sent Items & Inbox (+ 1 level of subfolders) for messages To/CC 'BOM' or 'Transmittal'
    Persists all discovered (Job #, Lot #) BOM emails into SQLite `bom_seen` so deleted Inbox messages remain remembered.
    """
    if os.name != "nt":
        return {"ok": False, "mailbox_found": False, "scanned_messages": 0, "newly_recorded": 0}

    ps_script = r"""
$ErrorActionPreference = 'SilentlyContinue'
$sinceStr = $env:SCOVILLE_BOM_SINCE
if (-not $sinceStr) { $sinceStr = '2026-11-24' }
$cutoff = [datetime]::Parse($sinceStr).AddDays(-1)

$ol = New-Object -ComObject Outlook.Application
if (-not $ol) {
    @{ ok = $false; error = 'Outlook unavailable' } | ConvertTo-Json -Compress
    exit 0
}
$ns = $ol.GetNamespace('MAPI')
$results = New-Object System.Collections.Generic.List[object]
$detFound = $false

function Scan-Folder($folder, [bool]$requireBomFilter, [string]$sourceTag) {
    if (-not $folder) { return }
    try {
        $items = $folder.Items
        if (-not $items -or $items.Count -eq 0) { return }
        $items.Sort('[ReceivedTime]', $true)
        $checked = 0
        foreach ($m in $items) {
            $checked++
            if ($checked -gt 250) { break }
            $dt = $null
            try { $dt = $m.ReceivedTime } catch {}
            if (-not $dt) {
                try { $dt = $m.SentOn } catch {}
            }
            if ($dt -and $dt -lt $cutoff) { break }

            $subj = [string]$m.Subject
            $toStr = [string]$m.To
            $ccStr = [string]$m.CC
            if ($requireBomFilter) {
                $combinedRcpt = "$toStr $ccStr"
                if (($combinedRcpt -notmatch '\bBOM\b') -and ($subj -notmatch 'Transmittal')) {
                    continue
                }
            }

            $atts = @()
            try {
                foreach ($a in $m.Attachments) {
                    $fn = [string]$a.FileName
                    if ($fn -and $fn -notmatch '^image\d+\.') { $atts += $fn }
                }
            } catch {}

            $bodySnip = ''
            try {
                $b = [string]$m.Body
                if ($b.Length -gt 600) { $bodySnip = $b.Substring(0, 600) } else { $bodySnip = $b }
            } catch {}

            $dtIso = ''
            if ($dt) { $dtIso = $dt.ToString('yyyy-MM-ddTHH:mm:ss') }

            $results.Add(@{
                subject = $subj
                to = $toStr
                cc = $ccStr
                sender = [string]$m.SenderName
                received_at = $dtIso
                attachments = $atts
                body_snippet = $bodySnip
                source = $sourceTag
            })
        }
    } catch {}
}

foreach ($store in $ns.Folders) {
    $sName = [string]$store.Name
    if ($sName -match 'Detailing|BOM') {
        $detFound = $true
        foreach ($fName in @('Inbox', 'Sent Items', 'Deleted Items', 'Archive')) {
            $f = $null
            try { $f = $store.Folders.Item($fName) } catch {}
            if ($f) {
                Scan-Folder $f $false "detailing_mailbox:$fName"
                try {
                    foreach ($sf in $f.Folders) {
                        Scan-Folder $sf $false "detailing_mailbox:$fName/$($sf.Name)"
                    }
                } catch {}
            }
        }
    }
}

# Also scan local user's own Sent Items & Inbox (for BOM emails sent before or after Detailing Mailbox cleanup)
try {
    $defInbox = $ns.GetDefaultFolder(6)
    if ($defInbox) {
        Scan-Folder $defInbox $true 'user_inbox'
        foreach ($sf in $defInbox.Folders) {
            Scan-Folder $sf $true "user_inbox/$($sf.Name)"
        }
    }
} catch {}
try {
    $defSent = $ns.GetDefaultFolder(5)
    if ($defSent) {
        Scan-Folder $defSent $true 'user_sent'
    }
} catch {}

@{
    ok = $true
    mailbox_found = $detFound
    messages = $results
} | ConvertTo-Json -Depth 5 -Compress
"""
    env = os.environ.copy()
    env["SCOVILLE_BOM_SINCE"] = since_iso or "2026-11-24"
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps_script],
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
        )
        raw_out = (proc.stdout or "").strip()
        if not raw_out:
            return {"ok": False, "mailbox_found": False, "scanned_messages": 0, "newly_recorded": 0}
        # Extract last JSON line in case COM printed any warning
        json_line = raw_out.splitlines()[-1].strip()
        data = json.loads(json_line)
        if not data.get("ok"):
            return {"ok": False, "mailbox_found": False, "scanned_messages": 0, "newly_recorded": 0}

        messages = data.get("messages") or []
        if isinstance(messages, dict):
            messages = [messages]

        to_upsert: list[dict] = []
        for msg in messages:
            subj = msg.get("subject") or ""
            atts = msg.get("attachments") or []
            if isinstance(atts, str):
                atts = [atts]
            body_snip = msg.get("body_snippet") or ""
            pairs = extract_job_lot_pairs(subj, atts, body_snip)
            for j_num, l_num in pairs:
                to_upsert.append(
                    {
                        "job_number": j_num,
                        "lot_number": l_num,
                        "subject": subj,
                        "sender": msg.get("sender") or "",
                        "received_at": msg.get("received_at") or "",
                        "source": msg.get("source") or "outlook",
                    }
                )

        newly_recorded = db.upsert_bom_seen_entries(to_upsert)
        return {
            "ok": True,
            "mailbox_found": bool(data.get("mailbox_found")),
            "scanned_messages": len(messages),
            "matched_pairs": len(to_upsert),
            "newly_recorded": newly_recorded,
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": str(exc),
            "mailbox_found": False,
            "scanned_messages": 0,
            "newly_recorded": 0,
        }

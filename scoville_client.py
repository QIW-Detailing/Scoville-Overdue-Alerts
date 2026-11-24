from __future__ import annotations

import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime
from html.parser import HTMLParser
from urllib.parse import urljoin

import requests
from requests.adapters import HTTPAdapter

TRACKED_MILESTONES = [
    {"key": "fm", "label": "Field Measurements", "short": "Field Dims (FM)", "notify_ps": True},
    {"key": "dwg_complete", "label": "DWG Complete", "short": "DWG Complete", "notify_ps": False},
    {"key": "engineer_calcs", "label": "Engineer Calcs", "short": "Engineer Calcs", "notify_ps": False},
    {"key": "approval_submittal", "label": "Approval Submittal", "short": "Approval Submittal", "notify_ps": False},
    {"key": "release_to_shop", "label": "Release to Shop", "short": "Release to Shop", "notify_ps": False},
    {"key": "ps_request", "label": "PS Request", "short": "PS Request", "notify_ps": True},
]

DETAILING_CALENDAR_KEYS = ("fm", "dwg_complete", "engineer_calcs", "approval_submittal", "release_to_shop")
MILESTONE_BY_KEY = {m["key"]: m for m in TRACKED_MILESTONES}
ZERO_VALUE_PLACEHOLDER_IDS = {"17188", "17187", "17352"}


class _ScovilleTableParser(HTMLParser):
    """Parses Scoville server-rendered Semantic-UI schedule tables."""

    def __init__(self) -> None:
        super().__init__()
        self.in_thead = False
        self.in_tbody = False
        self.in_th = False
        self.in_tr = False
        self.in_td = False

        self.headers: list[str] = []
        self._cur_th: list[str] = []

        self.rows: list[dict] = []
        self._cur_tr_attrs: dict[str, str] = {}
        self._cur_cells: list[dict] = []
        self._cur_cell: dict | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {k.lower(): (v or "") for k, v in attrs}
        t = tag.lower()

        if t == "thead":
            self.in_thead = True
        elif t == "tbody":
            self.in_tbody = True
        elif t == "th" and self.in_thead:
            self.in_th = True
            self._cur_th = []
        elif t == "tr" and self.in_tbody:
            self.in_tr = True
            self._cur_tr_attrs = attr_map
            self._cur_cells = []
        elif t == "td" and self.in_tr:
            self.in_td = True
            self._cur_cell = {
                "class": attr_map.get("class", ""),
                "style": attr_map.get("style", ""),
                "text_parts": [],
                "has_check": False,
                "has_calendar": False,
                "has_exclamation": False,
                "href": "",
            }
        elif self.in_th and t in ("div", "br", "p"):
            self._cur_th.append(" ")
        elif self.in_td and self._cur_cell is not None:
            if t in ("div", "br", "p"):
                self._cur_cell["text_parts"].append("\n")
            elif t == "a" and not self._cur_cell["href"]:
                self._cur_cell["href"] = attr_map.get("href", "")
            elif t == "i":
                cls = attr_map.get("class", "").lower()
                if "check" in cls:
                    self._cur_cell["has_check"] = True
                if "fa-calendar" in cls or "calendar" in cls:
                    self._cur_cell["has_calendar"] = True
                if "exclamation" in cls:
                    self._cur_cell["has_exclamation"] = True

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if t == "thead":
            self.in_thead = False
        elif t == "tbody":
            self.in_tbody = False
        elif t == "th" and self.in_th:
            self.in_th = False
            txt = re.sub(r"\s+", " ", "".join(self._cur_th)).strip()
            self.headers.append(txt)
        elif t == "td" and self.in_td:
            self.in_td = False
            if self._cur_cell is not None:
                raw_text = "".join(self._cur_cell["text_parts"])
                lines = [re.sub(r"\s+", " ", ln).strip() for ln in raw_text.splitlines()]
                lines = [ln for ln in lines if ln]
                self._cur_cell["lines"] = lines
                self._cur_cell["text"] = " ".join(lines).strip()
                del self._cur_cell["text_parts"]
                self._cur_cells.append(self._cur_cell)
                self._cur_cell = None
        elif t == "tr" and self.in_tr:
            self.in_tr = False
            if self._cur_cells:
                self.rows.append(
                    {
                        "tr_class": self._cur_tr_attrs.get("class", ""),
                        "tr_style": self._cur_tr_attrs.get("style", ""),
                        "cells": self._cur_cells,
                    }
                )
            self._cur_cells = []

    def handle_data(self, data: str) -> None:
        if self.in_th:
            self._cur_th.append(data)
        elif self.in_th and t in ("div", "br", "p"):
            self._cur_th.append(" ")
        elif self.in_td and self._cur_cell is not None:
            self._cur_cell["text_parts"].append(data)


class _EditPageParser(HTMLParser):
    """Extracts <input> values, checkbox states, and DPM/PS labels from /item/<QKEY>/edit."""

    def __init__(self) -> None:
        super().__init__()
        self.inputs_by_name: dict[str, dict] = {}
        self.inputs_by_id: dict[str, dict] = {}
        self.dpm_name: str = ""
        self.ps_name: str = ""
        self._in_cat_td = False
        self._in_data_td = False
        self._cur_td_text: list[str] = []
        self._last_cat_label: str = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        t = tag.lower()
        attr_map = {k.lower(): (v or "") for k, v in attrs}
        if t == "td":
            cls = attr_map.get("class", "")
            if "edittablecategory" in cls.lower():
                self._in_cat_td = True
                self._cur_td_text = []
            elif "edittabledata" in cls.lower():
                self._in_data_td = True
                self._cur_td_text = []
            return
        if t != "input":
            return
        attr_keys = {k.lower() for k, _ in attrs}
        info = {
            "type": attr_map.get("type", "").lower(),
            "value": attr_map.get("value", "").strip(),
            "checked": "checked" in attr_keys,
        }
        name = attr_map.get("name", "").strip()
        el_id = attr_map.get("id", "").strip()
        if name:
            self.inputs_by_name[name] = info
        if el_id:
            self.inputs_by_id[el_id] = info

    def handle_data(self, data: str) -> None:
        if self._in_cat_td or self._in_data_td:
            self._cur_td_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() != "td":
            return
        if self._in_cat_td:
            self._in_cat_td = False
            self._last_cat_label = re.sub(r"\s+", " ", "".join(self._cur_td_text)).strip().lower()
        elif self._in_data_td:
            self._in_data_td = False
            val = re.sub(r"\s+", " ", "".join(self._cur_td_text)).strip()
            if self._last_cat_label.startswith("dpm") and val and not self.dpm_name:
                self.dpm_name = val
            elif self._last_cat_label.startswith("ps") and val and not self.ps_name:
                self.ps_name = val
            self._last_cat_label = ""


class _ForecastValuesParser(HTMLParser):
    """
    Extracts <option> items from the first `Scope Items & Values` <select>
    (`#categoryScopeItem1` / `name="updated[forecastID]"`) on `/item/<QKEY>/forecastValues`.
    """

    def __init__(self) -> None:
        super().__init__()
        self._in_target_select = False
        self._captured_first_select = False
        self._in_option = False
        self._cur_opt_attrs: dict[str, str] = {}
        self._cur_opt_text: list[str] = []
        self.options: list[dict] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        t = tag.lower()
        attr_map = {k.lower(): (v or "") for k, v in attrs}
        if t == "select":
            if self._in_target_select:
                # Stop immediately if a second <select> starts without closing the first
                self._in_target_select = False
            elif not self._captured_first_select:
                el_id = attr_map.get("id", "")
                name = attr_map.get("name", "")
                cls = attr_map.get("class", "")
                if (
                    el_id == "categoryScopeItem1"
                    or name == "updated[forecastID]"
                    or "categoryscopeitem" in cls.lower()
                ):
                    self._in_target_select = True
                    self._captured_first_select = True
        elif t == "option" and self._in_target_select:
            self._in_option = True
            self._cur_opt_attrs = attr_map
            self._cur_opt_text = []

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if t == "option" and self._in_option:
            self._in_option = False
            txt = re.sub(r"\s+", " ", "".join(self._cur_opt_text)).strip()
            self.options.append(
                {
                    "value": self._cur_opt_attrs.get("value", "").strip(),
                    "itemjob": self._cur_opt_attrs.get("itemjob", "").strip(),
                    "revenue": self._cur_opt_attrs.get("revenue", "").strip(),
                    "text": txt,
                }
            )
        elif t == "select" and self._in_target_select:
            self._in_target_select = False

    def handle_data(self, data: str) -> None:
        if self._in_option:
            self._cur_opt_text.append(data)


def _extract_real_scope_options(html_text: str) -> tuple[bool, list[str]]:
    """
    Returns (is_valid_forecast_page, real_scopes) from `/item/<QKEY>/forecastValues`,
    filtering out blank and the 3 default placeholder options:
      - Unbillable (No Value) [$1]
      - Unwritten CO [$2]
      - Unapproved CO [$3]
    """
    p = _ForecastValuesParser()
    p.feed(html_text)
    if not p._captured_first_select or len(p.options) < 3:
        return False, []

    real_scopes: list[str] = []
    seen_vals: set[str] = set()
    for opt in p.options:
        val = opt["value"]
        txt = opt["text"]
        low = txt.lower()
        if not val or not txt or val in seen_vals:
            continue
        seen_vals.add(val)
        if (
            val in ZERO_VALUE_PLACEHOLDER_IDS
            or opt["itemjob"] == "10000"
            or "unbillable (no value)" in low
            or "unwritten co" in low
            or "unapproved co" in low
        ):
            continue
        real_scopes.append(txt)
    return True, real_scopes


def _is_zero_dollar_value(raw_val: str) -> bool:
    """True ONLY when value represents $0 / $0.00 (ignores $1, $2 CO, $3 CO, >$0)."""
    cleaned = (raw_val or "").replace("$", "").replace(",", "").strip()
    return bool(re.fullmatch(r"0+(\.0+)?", cleaned))


def parse_scoville_date(raw: str) -> str | None:
    txt = (raw or "").strip()
    if not txt:
        return None
    m = re.search(r"\b(\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2})\b", txt)
    if not m:
        return None
    token = m.group(1)
    for fmt in ("%m/%d/%y", "%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(token, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def format_display_date(iso_date: str | None) -> str:
    if not iso_date:
        return "—"
    try:
        return datetime.strptime(iso_date, "%Y-%m-%d").strftime("%m/%d/%Y")
    except ValueError:
        return iso_date


def _parse_milestone_cell(cell: dict | None) -> dict:
    if not cell:
        return {"status": "unscheduled", "date": None, "display": "Unscheduled"}
    if cell.get("has_check"):
        return {"status": "completed", "date": None, "display": "Completed"}
    iso_dt = parse_scoville_date(cell.get("text", ""))
    if iso_dt:
        return {
            "status": "scheduled",
            "date": iso_dt,
            "display": format_display_date(iso_dt),
        }
    return {"status": "unscheduled", "date": None, "display": "Unscheduled"}


def _extract_edit_details(
    html_text: str, tekla_linked: bool = False
) -> tuple[dict[str, dict] | None, bool, str, str]:
    p = _EditPageParser()
    p.feed(html_text)
    if not p.inputs_by_name and not p.inputs_by_id:
        return None, False, "", ""

    is_linked = tekla_linked or (
        "CKBXdwgComplete" not in p.inputs_by_name and "dwgComplete" not in p.inputs_by_id
    )

    def build_field(date_name: str, chk_name: str | None, chk_id: str | None, date_id: str | None = None) -> dict:
        if chk_name or chk_id:
            chk = (p.inputs_by_name.get(chk_name) if chk_name else None) or (
                p.inputs_by_id.get(chk_id) if chk_id else None
            )
            if chk and chk.get("checked"):
                return {"status": "completed", "date": None, "display": "Completed"}
        dt_inp = p.inputs_by_name.get(date_name) or (p.inputs_by_id.get(date_id) if date_id else None)
        raw_val = dt_inp.get("value", "") if dt_inp else ""
        iso_dt = parse_scoville_date(raw_val)
        if iso_dt:
            return {
                "status": "scheduled",
                "date": iso_dt,
                "display": format_display_date(iso_dt),
            }
        return {"status": "unscheduled", "date": None, "display": "Unscheduled"}

    ps_req = (
        {"status": "completed", "date": None, "display": "Linked to Tekla"}
        if is_linked
        else build_field("updated[psRequestedDeliveryDate]", None, None, date_id="psReqDateCheck")
    )

    milestones = {
        "fm": build_field("updated[fmDate]", "CKBXneedFM", "needFM"),
        "dwg_complete": build_field("updated[dwgCompleteDate]", "CKBXdwgComplete", "dwgComplete"),
        "engineer_calcs": build_field("updated[dpmReviewDate]", "CKBXdpmReview", "dpmReview"),
        "approval_submittal": build_field("updated[approvalSubmittalDate]", "CKBXapprovalSubmittal", "approvalSubmittal"),
        "release_to_shop": build_field("updated[releaseDate]", None, None, date_id="releaseDateCheck"),
        "ps_request": ps_req,
    }
    return milestones, is_linked, p.dpm_name, p.ps_name


def _extract_edit_milestones(html_text: str, tekla_linked: bool = False) -> dict[str, dict] | None:
    ms, _, _, _ = _extract_edit_details(html_text, tekla_linked=tekla_linked)
    return ms


def _clean_cat_sub(cell: dict | None) -> tuple[str, str]:
    if not cell:
        return "", ""
    lines = cell.get("lines", [])
    cat = ""
    sub = ""
    if len(lines) >= 2:
        cat = re.sub(r"^Cat\s*-\s*", "", lines[0], flags=re.IGNORECASE).strip()
        sub = re.sub(r"^Sub\s*-\s*", "", lines[1], flags=re.IGNORECASE).strip()
    elif len(lines) == 1:
        cat = re.sub(r"^Cat\s*-\s*", "", lines[0], flags=re.IGNORECASE).strip()
    return cat, sub


def fetch_scoville_data(base_url: str, email: str, password: str, timeout: int = 25) -> dict:
    """
    Logs into Scoville and scrapes:
      1) Unreleased detailing schedule + 6 date milestones (skipping Tekla-linked items for PS Request)
      2) ALL $0 items across BOTH released & unreleased (`/noValue` + `/admin/all`), checking
         `/item/<QKEY>/forecastValues` in parallel and catching ONLY $0 items that have real
         job scope values beyond the 3 default placeholders ($1/$2/$3).
    Read-only: never modifies Scoville items.
    """
    base = base_url.rstrip("/")
    session = requests.Session()
    adapter = HTTPAdapter(pool_connections=20, pool_maxsize=20)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    session.headers.update(
        {
            "User-Agent": "ScovilleOverdueMonitor/1.2 (QIWorks Detailing)",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
    )

    login_url = f"{base}/login"
    resp_login = session.post(
        login_url,
        data={"email": email, "password": password},
        allow_redirects=True,
        timeout=timeout,
    )
    resp_login.raise_for_status()

    is_my_view = False
    outlook_url = f"{base}/any_due_date/weeks/500"
    resp = session.get(outlook_url, allow_redirects=True, timeout=timeout)
    resp.raise_for_status()

    if "/login" in resp.url.lower() and "loginform" in resp.text.lower():
        raise RuntimeError(
            "Scoville login failed — redirected back to /login. Please verify Scoville email & password in Settings."
        )

    if "/accessdenied" in resp.url.lower() or "not authorized" in resp.text.lower():
        # Non-admin DPM/PS account: fall back automatically to /my/ routes!
        is_my_view = True
        resp = session.get(f"{base}/my/any_due_date/weeks/500", allow_redirects=True, timeout=timeout)
        resp.raise_for_status()
        if "/login" in resp.url.lower() and "loginform" in resp.text.lower():
            raise RuntimeError(
                "Scoville login failed — redirected back to /login. Please verify Scoville email & password in Settings."
            )

    parser = _ScovilleTableParser()
    parser.feed(resp.text)
    header_idx: dict[str, int] = {h.lower(): idx for idx, h in enumerate(parser.headers)}

    def col(cells: list[dict], name: str, default_idx: int) -> dict | None:
        idx = header_idx.get(name.lower(), default_idx)
        return cells[idx] if 0 <= idx < len(cells) else None

    items_by_qkey: dict[str, dict] = {}
    ps_req_needs_edit_lookup: set[str] = set()
    on_hold_qkeys: set[str] = set()

    for row in parser.rows:
        cells = row["cells"]
        if len(cells) < 12:
            continue
        qkey_cell = col(cells, "qkey", 1)
        qkey = (qkey_cell["text"] if qkey_cell else "").strip()
        if not qkey or not qkey.isdigit():
            continue

        tr_class = row.get("tr_class", "")
        on_hold = "onhold" in tr_class.lower()
        if on_hold:
            on_hold_qkeys.add(qkey)

        priority_cell = col(cells, "priority", 0)
        priority = (priority_cell["text"] if priority_cell else "").strip()

        job_num_cell = col(cells, "job #", 2)
        job_site_cell = col(cells, "job site", 3)
        cat_sub_cell = col(cells, "category subcategory", 4)
        seq_cell = col(cells, "seq", 5)

        rel_cell = col(cells, "release to shop date", 6)
        fm_cell = col(cells, "fm", 7)
        dwg_cell = col(cells, "dwg complete", 8)
        calc_cell = col(cells, "engineer calcs", 9)
        subm_cell = col(cells, "approval submittal", 10)

        ps_name = ""
        dpm_name = ""
        for c in cells:
            classes = f" {c.get('class', '')} "
            if " PS " in classes and not ps_name:
                ps_name = c.get("text", "").strip()
            elif " DPM " in classes and not dpm_name:
                dpm_name = c.get("text", "").strip()
        if not ps_name:
            ps_c = col(cells, "ps", 12)
            ps_name = (ps_c["text"] if ps_c else "").strip()
        if not dpm_name:
            dpm_c = col(cells, "dpm", 13)
            dpm_name = (dpm_c["text"] if dpm_c else "").strip()

        val_cell = col(cells, "value", 14)
        cat, sub = _clean_cat_sub(cat_sub_cell)

        edit_path = f"/item/{qkey}/edit"
        if qkey_cell and qkey_cell.get("href"):
            edit_path = qkey_cell["href"]

        items_by_qkey[qkey] = {
            "qkey": qkey,
            "priority": priority,
            "on_hold": on_hold,
            "lot_number": "",
            "tekla_linked": False,
            "job_number": (job_num_cell["text"] if job_num_cell else "").strip(),
            "job_site": (job_site_cell["text"] if job_site_cell else "").strip(),
            "category": cat,
            "sub_category": sub,
            "sequence": (seq_cell["text"] if seq_cell else "").strip(),
            "dpm": dpm_name or "Unassigned",
            "ps": ps_name or "Unassigned",
            "value": (val_cell["text"] if val_cell else "").strip(),
            "edit_url": urljoin(f"{base}/", edit_path.lstrip("/")),
            "milestones": {
                "fm": _parse_milestone_cell(fm_cell),
                "dwg_complete": _parse_milestone_cell(dwg_cell),
                "engineer_calcs": _parse_milestone_cell(calc_cell),
                "approval_submittal": _parse_milestone_cell(subm_cell),
                "release_to_shop": _parse_milestone_cell(rel_cell),
                "ps_request": {"status": "unscheduled", "date": None, "display": "Unscheduled"},
            },
        }

    # Pass 2: /release_to_shop/all (or /my/release_to_shop/all for non-admin users)
    # Populates `PS Request Date` AND fills in DPM/PS names (`PS/DPM` = "<DPM> / <PS>") on /my/ views!
    try:
        rts_path = "/my/release_to_shop/all" if is_my_view else "/release_to_shop/all"
        all_resp = session.get(f"{base}{rts_path}", allow_redirects=True, timeout=timeout)
        if not is_my_view and ("/accessdenied" in all_resp.url.lower() or "not authorized" in all_resp.text.lower()):
            is_my_view = True
            all_resp = session.get(f"{base}/my/release_to_shop/all", allow_redirects=True, timeout=timeout)

        if all_resp.ok and "/login" not in all_resp.url.lower() and "/accessdenied" not in all_resp.url.lower():
            p2 = _ScovilleTableParser()
            p2.feed(all_resp.text)
            h2 = {h.lower(): idx for idx, h in enumerate(p2.headers)}
            ps_req_idx = h2.get("ps request date", 15)
            psdpm_idx = h2.get("ps/dpm")

            for row in p2.rows:
                cells = row["cells"]
                if len(cells) < 14:
                    continue
                qkey = cells[1]["text"].strip()
                if not qkey.isdigit():
                    continue
                on_hold = "onhold" in row.get("tr_class", "").lower()
                if on_hold:
                    on_hold_qkeys.add(qkey)

                # Extract DPM & PS either from separate columns (admin) or combined `PS/DPM` ("DPM / PS" on /my/)
                row_dpm = ""
                row_ps = ""
                if psdpm_idx is not None and 0 <= psdpm_idx < len(cells):
                    psdpm_txt = cells[psdpm_idx]["text"].strip()
                    if "/" in psdpm_txt:
                        d_part, p_part = psdpm_txt.split("/", 1)
                        row_dpm = d_part.strip()
                        row_ps = p_part.strip()
                    elif psdpm_txt:
                        row_dpm = psdpm_txt
                else:
                    row_ps = cells[10]["text"].strip() if len(cells) > 10 else ""
                    row_dpm = cells[11]["text"].strip() if len(cells) > 11 else ""

                ps_req_cell = cells[ps_req_idx] if 0 <= ps_req_idx < len(cells) else None
                if qkey not in items_by_qkey:
                    items_by_qkey[qkey] = {
                        "qkey": qkey,
                        "priority": cells[0]["text"].strip(),
                        "on_hold": on_hold,
                        "lot_number": "",
                        "tekla_linked": False,
                        "job_number": cells[2]["text"].strip(),
                        "job_site": cells[3]["text"].strip(),
                        "category": cells[4]["text"].strip(),
                        "sub_category": cells[5]["text"].strip(),
                        "sequence": cells[6]["text"].strip(),
                        "dpm": row_dpm or "Unassigned",
                        "ps": row_ps or "Unassigned",
                        "value": cells[12]["text"].strip() if len(cells) > 12 else "",
                        "edit_url": f"{base}/item/{qkey}/edit",
                        "milestones": {
                            "fm": _parse_milestone_cell(cells[8] if len(cells) > 8 else None),
                            "dwg_complete": {"status": "unscheduled", "date": None, "display": "Unscheduled"},
                            "engineer_calcs": {"status": "unscheduled", "date": None, "display": "Unscheduled"},
                            "approval_submittal": {"status": "unscheduled", "date": None, "display": "Unscheduled"},
                            "release_to_shop": _parse_milestone_cell(cells[7] if len(cells) > 7 else None),
                            "ps_request": {"status": "unscheduled", "date": None, "display": "Unscheduled"},
                        },
                    }
                else:
                    if row_dpm and items_by_qkey[qkey]["dpm"] == "Unassigned":
                        items_by_qkey[qkey]["dpm"] = row_dpm
                    if row_ps and items_by_qkey[qkey]["ps"] == "Unassigned":
                        items_by_qkey[qkey]["ps"] = row_ps

                if ps_req_cell:
                    if ps_req_cell.get("has_exclamation"):
                        ps_req_needs_edit_lookup.add(qkey)
                    else:
                        items_by_qkey[qkey]["milestones"]["ps_request"] = _parse_milestone_cell(ps_req_cell)
    except Exception:
        pass

    # Pass 3: /noValue + /admin/all — check `Lot #` (Tekla link) AND gather ALL $0 items
    # across BOTH released and unreleased!
    zero_candidates: dict[str, dict] = {}

    try:
        noval_resp = session.get(f"{base}/noValue", allow_redirects=True, timeout=timeout)
        if noval_resp.ok and "/login" not in noval_resp.url.lower() and "/accessdenied" not in noval_resp.url.lower():
            pnv = _ScovilleTableParser()
            pnv.feed(noval_resp.text)
            hnv = {h.lower(): idx for idx, h in enumerate(pnv.headers)}
            q_i = hnv.get("qkey", 1)
            val_i = hnv.get("value", 12)
            for row in pnv.rows:
                cells = row["cells"]
                if len(cells) <= max(q_i, val_i):
                    continue
                qkey = cells[q_i]["text"].strip()
                if not qkey.isdigit():
                    continue
                on_hold = "onhold" in row.get("tr_class", "").lower()
                if on_hold:
                    on_hold_qkeys.add(qkey)
                val_txt = cells[val_i]["text"].strip()
                if _is_zero_dollar_value(val_txt):
                    ps_name = cells[hnv.get("ps", 10)]["text"].strip() if len(cells) > 10 else ""
                    dpm_name = cells[hnv.get("dpm", 11)]["text"].strip() if len(cells) > 11 else ""
                    zero_candidates[qkey] = {
                        "qkey": qkey,
                        "on_hold": qkey in on_hold_qkeys,
                        "released": False,
                        "lot_number": "",
                        "job_number": cells[hnv.get("job #", 2)]["text"].strip(),
                        "job_site": cells[hnv.get("job site", 3)]["text"].strip(),
                        "category": cells[hnv.get("category", 4)]["text"].strip(),
                        "sub_category": cells[hnv.get("sub category", 5)]["text"].strip(),
                        "sequence": cells[hnv.get("seq", 6)]["text"].strip(),
                        "dpm": dpm_name or "Unassigned",
                        "ps": ps_name or "Unassigned",
                        "value": val_txt or "$0",
                        "edit_url": f"{base}/item/{qkey}/edit",
                        "forecast_url": f"{base}/item/{qkey}/forecastValues",
                    }
    except Exception:
        pass

    # Also capture any $0 items present directly in items_by_qkey (especially for /my/ scoped accounts)
    for qk, it in items_by_qkey.items():
        if _is_zero_dollar_value(it.get("value", "")) and qk not in zero_candidates:
            zero_candidates[qk] = {
                "qkey": qk,
                "on_hold": bool(it.get("on_hold")),
                "released": False,
                "lot_number": "",
                "job_number": it.get("job_number", ""),
                "job_site": it.get("job_site", ""),
                "category": it.get("category", ""),
                "sub_category": it.get("sub_category", ""),
                "sequence": it.get("sequence", ""),
                "dpm": it.get("dpm", "Unassigned"),
                "ps": it.get("ps", "Unassigned"),
                "value": it.get("value") or "$0",
                "edit_url": f"{base}/item/{qk}/edit",
                "forecast_url": f"{base}/item/{qk}/forecastValues",
            }

    if not is_my_view:
        try:
            adm_resp = session.get(f"{base}/admin/all", allow_redirects=True, timeout=timeout)
            if adm_resp.ok and "/login" not in adm_resp.url.lower() and "/accessdenied" not in adm_resp.url.lower():
                p3 = _ScovilleTableParser()
                p3.feed(adm_resp.text)
                h3 = {h.lower(): idx for idx, h in enumerate(p3.headers)}
                q_idx = h3.get("qkey", 0)
                lot_idx = h3.get("lot #", 6)
                val_idx = h3.get("value", 14)
                ps_idx = h3.get("ps", 12)
                dpm_idx = h3.get("dpm", 13)

                for row in p3.rows:
                    cells = row["cells"]
                    if len(cells) <= max(lot_idx, q_idx, val_idx):
                        continue
                    qkey = cells[q_idx]["text"].strip()
                    if not qkey.isdigit():
                        continue
                    on_hold = "onhold" in row.get("tr_class", "").lower()
                    if on_hold:
                        on_hold_qkeys.add(qkey)

                    lot_num = cells[lot_idx]["text"].strip()
                    val_txt = cells[val_idx]["text"].strip()

                    if qkey in items_by_qkey and lot_num:
                        items_by_qkey[qkey]["lot_number"] = lot_num
                        items_by_qkey[qkey]["tekla_linked"] = True

                    if qkey in zero_candidates:
                        zero_candidates[qkey]["lot_number"] = lot_num
                        zero_candidates[qkey]["released"] = bool(lot_num)
                        zero_candidates[qkey]["on_hold"] = qkey in on_hold_qkeys
                    elif not zero_candidates and _is_zero_dollar_value(val_txt):
                        zero_candidates[qkey] = {
                            "qkey": qkey,
                            "on_hold": qkey in on_hold_qkeys,
                            "released": bool(lot_num),
                            "lot_number": lot_num,
                            "job_number": cells[h3.get("job #", 1)]["text"].strip(),
                            "job_site": cells[h3.get("job site", 2)]["text"].strip(),
                            "category": cells[h3.get("category", 3)]["text"].strip(),
                            "sub_category": cells[h3.get("sub category", 4)]["text"].strip(),
                            "sequence": cells[h3.get("seq", 5)]["text"].strip(),
                            "dpm": (cells[dpm_idx]["text"].strip() if dpm_idx < len(cells) else "") or "Unassigned",
                            "ps": (cells[ps_idx]["text"].strip() if ps_idx < len(cells) else "") or "Unassigned",
                            "value": val_txt or "$0",
                            "edit_url": f"{base}/item/{qkey}/edit",
                            "forecast_url": f"{base}/item/{qkey}/forecastValues",
                        }
        except Exception:
            pass
    else:
        # For non-admin users, check /viewShopWIP if permitted to mark Tekla-linked QKEYs
        try:
            wip_resp = session.get(f"{base}/viewShopWIP", allow_redirects=True, timeout=timeout)
            if wip_resp.ok and "/login" not in wip_resp.url.lower() and "/accessdenied" not in wip_resp.url.lower():
                pwip = _ScovilleTableParser()
                pwip.feed(wip_resp.text)
                hwip = {h.lower(): idx for idx, h in enumerate(pwip.headers)}
                wq_idx = hwip.get("qkey", 4)
                for row in pwip.rows:
                    cells = row["cells"]
                    if wq_idx < len(cells):
                        wqk = cells[wq_idx]["text"].strip()
                        if wqk in items_by_qkey:
                            items_by_qkey[wqk]["tekla_linked"] = True
        except Exception:
            pass

    # Remove Tekla-linked items from date-overdue tracking
    for qk in [k for k, v in items_by_qkey.items() if v.get("tekla_linked")]:
        del items_by_qkey[qk]

    # Pass 4: Thread-safe parallel fetch of `/item/<QKEY>/edit` (for hidden past-due dates & DPM/PS/Tekla verification)
    qkeys_to_inspect = [
        qkey
        for qkey, it in items_by_qkey.items()
        if qkey in ps_req_needs_edit_lookup
        or it.get("dpm") == "Unassigned"
        or any(it["milestones"][k]["status"] == "unscheduled" for k in DETAILING_CALENDAR_KEYS)
    ]

    base_cookies = session.cookies.get_dict()
    _tls = threading.local()

    def _get_worker_session() -> requests.Session:
        ws = getattr(_tls, "session", None)
        if ws is None:
            ws = requests.Session()
            ws.mount("http://", HTTPAdapter(pool_connections=4, pool_maxsize=4))
            ws.headers.update(session.headers)
            ws.cookies.update(base_cookies)
            _tls.session = ws
        return ws

    def _fetch_one_edit(qkey: str) -> tuple[str, dict[str, dict] | None, bool, str, str]:
        ws = _get_worker_session()
        for _ in range(2):
            try:
                r = ws.get(f"{base}/item/{qkey}/edit", allow_redirects=True, timeout=timeout)
                if "/login" in r.url.lower():
                    ws.post(login_url, data={"email": email, "password": password}, allow_redirects=True, timeout=timeout)
                    continue
                if "/accessdenied" in r.url.lower():
                    return qkey, None, False, "", ""
                if r.ok:
                    ms, is_linked, e_dpm, e_ps = _extract_edit_details(r.text, tekla_linked=False)
                    if ms is not None:
                        return qkey, ms, is_linked, e_dpm, e_ps
            except Exception:
                pass
        return qkey, None, False, "", ""

    if qkeys_to_inspect:
        with ThreadPoolExecutor(max_workers=5) as pool:
            edit_futs = [pool.submit(_fetch_one_edit, q) for q in qkeys_to_inspect]
            for fut in as_completed(edit_futs):
                qkey, exact_ms, is_linked, e_dpm, e_ps = fut.result()
                if qkey in items_by_qkey:
                    if is_linked:
                        items_by_qkey[qkey]["tekla_linked"] = True
                    if exact_ms:
                        items_by_qkey[qkey]["milestones"] = exact_ms
                    if e_dpm:
                        items_by_qkey[qkey]["dpm"] = e_dpm
                    if e_ps:
                        items_by_qkey[qkey]["ps"] = e_ps

    # Remove any items discovered to be Tekla-linked during /edit inspection
    for qk in [k for k, v in items_by_qkey.items() if v.get("tekla_linked")]:
        del items_by_qkey[qk]

    # For non-admin (/my/) users, scope $0 candidates to their own accessible jobs/DPMs
    if is_my_view and items_by_qkey:
        my_dpms = {it["dpm"].lower() for it in items_by_qkey.values() if it.get("dpm") and it["dpm"] != "Unassigned"}
        my_jobs = {it["job_number"] for it in items_by_qkey.values() if it.get("job_number")}
        zero_candidates = {
            qk: cand
            for qk, cand in zero_candidates.items()
            if qk in items_by_qkey
            or cand.get("dpm", "").lower() in my_dpms
            or (cand.get("job_number") and cand["job_number"] in my_jobs)
        }

    # Pass 5: Reliable sequential `/item/<QKEY>/forecastValues` scan grouped by `Job #`!
    cands_by_job: dict[str, list[dict]] = {}
    for cand in zero_candidates.values():
        j_key = (cand.get("job_number") or "").strip() or f"_qkey_{cand['qkey']}"
        cands_by_job.setdefault(j_key, []).append(cand)

    caught_zero_items: list[dict] = []

    # Ensure main session is authenticated before Pass 5
    session.post(login_url, data={"email": email, "password": password}, allow_redirects=True, timeout=timeout)

    for j_key, job_cands in cands_by_job.items():
        job_scopes: list[str] = []
        for sample_cand in job_cands[:3]:
            qkey = sample_cand["qkey"]
            valid_page = False
            for _ in range(2):
                try:
                    r = session.get(f"{base}/item/{qkey}/forecastValues", allow_redirects=True, timeout=timeout)
                    if "/login" in r.url.lower():
                        session.post(login_url, data={"email": email, "password": password}, allow_redirects=True, timeout=timeout)
                        continue
                    if "/accessdenied" in r.url.lower():
                        break
                    if r.ok:
                        valid_page, scopes = _extract_real_scope_options(r.text)
                        if valid_page:
                            job_scopes = scopes
                            break
                except Exception:
                    pass
            if valid_page:
                break

        if job_scopes:
            for cand in job_cands:
                caught_zero_items.append(
                    {
                        **cand,
                        "available_scope_count": len(job_scopes),
                        "sample_scope_options": job_scopes[:5],
                    }
                )

    caught_zero_items.sort(key=lambda x: int(x["qkey"]))

    return {
        "items": sorted(items_by_qkey.values(), key=lambda x: int(x["qkey"])),
        "zero_value_items": caught_zero_items,
        "zero_value_scanned": len(zero_candidates),
        "is_scoped_user": is_my_view,
    }


def evaluate_items_and_packets(
    raw_items: list[dict],
    directory: list[dict],
    settings: dict,
    as_of_iso: str | None = None,
    include_due_today: bool | None = None,
    exclude_on_hold: bool | None = None,
    milestone_filter: str | None = None,
    zero_value_items: list[dict] | None = None,
    zero_value_scanned: int = 0,
    due_soon_days: int = 7,
) -> dict:
    """
    Evaluates:
      - Standard mode (`All` or one of the 6 date milestones): ONLY schedule date overdues.
        `$0 Items` are NEVER included in `All`.
      - Separate `$0 Items` mode (`milestone_filter == "zero_value"`): ONLY caught `$0` items
        (both released & unreleased) that have real job scope values available, routed to DPM ONLY!
    """
    ref_date = date.today()
    if as_of_iso:
        try:
            ref_date = datetime.strptime(as_of_iso, "%Y-%m-%d").date()
        except ValueError:
            pass

    req_filter = (milestone_filter or "").strip()
    is_zero_mode = req_filter == "zero_value"
    ms_filter = req_filter if req_filter in MILESTONE_BY_KEY else ""

    inc_today = settings.get("include_due_today", False) if include_due_today is None else include_due_today
    exc_hold = settings.get("exclude_on_hold", True) if exclude_on_hold is None else exclude_on_hold
    default_email = (settings.get("default_recipient_email") or "akanday@qiworks.com").strip()
    grouping_mode = settings.get("grouping_mode", "digest")

    dir_by_name = {d["name"].lower(): d for d in directory}

    def resolve_person(name: str) -> tuple[str, bool]:
        entry = dir_by_name.get((name or "").strip().lower())
        if entry:
            return (entry["email"] or default_email), bool(entry.get("active", True))
        return default_email, True

    # Filter $0 items by On-Hold toggle so the badge count is always ready
    active_zero_items = [
        z for z in (zero_value_items or []) if not (exc_hold and z.get("on_hold"))
    ]

    due_soon_days = max(1, min(365, int(due_soon_days or 7)))

    # Always compute the 6 date milestone counts so the top filter strip keeps live counts
    evaluated_items: list[dict] = []
    overdue_items: list[dict] = []
    due_soon_items: list[dict] = []
    milestone_counts = {m["key"]: 0 for m in TRACKED_MILESTONES}
    all_overdue_items_unfiltered_count = 0
    due_soon_count = 0
    due_soon_milestones_total = 0

    for item in raw_items:
        if item.get("tekla_linked"):
            continue
        if exc_hold and item.get("on_hold"):
            continue

        eval_milestones: dict[str, dict] = {}
        all_item_overdue_list: list[dict] = []
        filtered_item_overdue_list: list[dict] = []
        filtered_item_due_soon_list: list[dict] = []
        item_has_due_soon = False

        for m in TRACKED_MILESTONES:
            m_key = m["key"]
            raw_m = item.get("milestones", {}).get(
                m_key, {"status": "unscheduled", "date": None, "display": "Unscheduled"}
            )
            status = raw_m.get("status", "unscheduled")
            iso_dt = raw_m.get("date")
            days_overdue = None
            days_until = None
            is_overdue = False
            is_due_today = False
            is_due_soon = False

            if status == "scheduled" and iso_dt:
                try:
                    due_dt = datetime.strptime(iso_dt, "%Y-%m-%d").date()
                    delta = (ref_date - due_dt).days
                    days_overdue = delta
                    days_until = -delta
                    is_due_today = delta == 0
                    if inc_today:
                        is_overdue = delta >= 0
                    else:
                        is_overdue = delta > 0
                    if not is_overdue and 0 <= days_until <= due_soon_days:
                        is_due_soon = True
                except ValueError:
                    pass

            if is_due_soon and (not ms_filter or ms_filter == m_key):
                item_has_due_soon = True
                due_soon_milestones_total += 1

            enriched = {
                "key": m_key,
                "label": m["label"],
                "short": m["short"],
                "notify_ps": m["notify_ps"],
                "is_field_dims": m["notify_ps"],
                "status": status,
                "date": iso_dt,
                "display": raw_m.get("display", "—"),
                "days_overdue": days_overdue,
                "days_until": days_until,
                "is_overdue": is_overdue,
                "is_due_today": is_due_today,
                "is_due_soon": is_due_soon,
            }
            eval_milestones[m_key] = enriched
            if is_due_soon and not is_zero_mode and (not ms_filter or ms_filter == m_key):
                filtered_item_due_soon_list.append(enriched)
            if is_overdue:
                milestone_counts[m_key] += 1
                all_item_overdue_list.append(enriched)
                if not is_zero_mode and (not ms_filter or ms_filter == m_key):
                    filtered_item_overdue_list.append(enriched)

        if all_item_overdue_list:
            all_overdue_items_unfiltered_count += 1
        if item_has_due_soon and not is_zero_mode:
            due_soon_count += 1

        has_ps_overdue = any(m["notify_ps"] for m in filtered_item_overdue_list)
        dpm_email, dpm_active = resolve_person(item["dpm"])
        ps_email, ps_active = resolve_person(item["ps"])

        notify_roles = []
        if filtered_item_overdue_list:
            notify_roles.append({"role": "DPM", "name": item["dpm"], "email": dpm_email, "active": dpm_active})
            if has_ps_overdue:
                notify_roles.append({"role": "PS", "name": item["ps"], "email": ps_email, "active": ps_active})

        enriched_item = {
            **item,
            "milestones": eval_milestones,
            "overdue_milestones": filtered_item_overdue_list,
            "due_soon_milestones": filtered_item_due_soon_list,
            "overdue_count": len(filtered_item_overdue_list),
            "due_soon_count": len(filtered_item_due_soon_list),
            "is_overdue": len(filtered_item_overdue_list) > 0,
            "is_due_soon": len(filtered_item_due_soon_list) > 0,
            "has_ps_overdue": has_ps_overdue,
            "max_days_overdue": max((m["days_overdue"] or 0 for m in filtered_item_overdue_list), default=0),
            "min_days_until": min((m["days_until"] for m in filtered_item_due_soon_list if m["days_until"] is not None), default=9999),
            "notify_recipients": notify_roles,
        }
        evaluated_items.append(enriched_item)
        if enriched_item["is_overdue"]:
            overdue_items.append(enriched_item)
        if enriched_item["is_due_soon"]:
            due_soon_items.append(enriched_item)

    due_soon_items.sort(key=lambda x: (x["min_days_until"], int(x["qkey"])))

    # SEPARATE MODE: `$0 Items` (DPM ONLY, Released + Unreleased, NOT in `All`!)
    if is_zero_mode:
        zero_enriched_items: list[dict] = []
        for z in active_zero_items:
            dpm_email, dpm_active = resolve_person(z["dpm"])
            rel_tag = f"Released ({z['lot_number']})" if z.get("released") else "Unreleased"
            scope_cnt = z.get("available_scope_count", 0)
            z_badge = {
                "key": "zero_value",
                "label": "$0 Item — Scope Available",
                "short": "$0 Value",
                "display": f"{scope_cnt} scope item{'s' if scope_cnt != 1 else ''} available",
                "days_overdue": None,
                "is_overdue": True,
                "is_zero_value": True,
                "release_status": rel_tag,
                "sample_scopes": z.get("sample_scope_options", []),
            }
            zero_enriched_items.append(
                {
                    **z,
                    "is_zero_value_item": True,
                    "release_status": rel_tag,
                    "overdue_milestones": [z_badge],
                    "relevant_milestones": [z_badge],
                    "is_overdue": True,
                    "notify_recipients": [
                        {"role": "DPM", "name": z["dpm"], "email": dpm_email, "active": dpm_active}
                    ],
                }
            )

        packets: list[dict] = []
        if grouping_mode == "per_item":
            for zit in zero_enriched_items:
                dpm_email, dpm_active = resolve_person(zit["dpm"])
                if not dpm_active or not dpm_email:
                    continue
                packets.append(
                    {
                        "packet_id": f"zero_item:{zit['qkey']}",
                        "packet_kind": "zero_value",
                        "recipient_name": f"{zit['dpm']} (DPM — $0 Item)",
                        "person_name": zit["dpm"],
                        "role": "DPM ($0 Items)",
                        "to_emails": [dpm_email],
                        "item_count": 1,
                        "milestone_count": 1,
                        "qkeys": [zit["qkey"]],
                        "items": [zit],
                    }
                )
        else:
            dpm_buckets: dict[str, dict] = {}
            for zit in zero_enriched_items:
                dpm_name = zit["dpm"]
                dpm_email, dpm_active = resolve_person(dpm_name)
                if not dpm_active or not dpm_email:
                    continue
                b_key = f"zero_dpm:{dpm_name.strip().lower()}"
                if b_key not in dpm_buckets:
                    dpm_buckets[b_key] = {
                        "packet_id": b_key,
                        "packet_kind": "zero_value",
                        "person_name": dpm_name,
                        "role": "DPM ($0 Items)",
                        "to_emails": [dpm_email],
                        "items": [],
                    }
                dpm_buckets[b_key]["items"].append(zit)

            for b in sorted(dpm_buckets.values(), key=lambda x: x["person_name"].lower()):
                packets.append(
                    {
                        "packet_id": b["packet_id"],
                        "packet_kind": "zero_value",
                        "recipient_name": f"{b['person_name']} ({b['role']})",
                        "person_name": b["person_name"],
                        "role": b["role"],
                        "to_emails": b["to_emails"],
                        "item_count": len(b["items"]),
                        "milestone_count": len(b["items"]),
                        "qkeys": [x["qkey"] for x in b["items"]],
                        "items": b["items"],
                    }
                )

        return {
            "as_of_date": ref_date.isoformat(),
            "as_of_display": ref_date.strftime("%m/%d/%Y"),
            "include_due_today": inc_today,
            "exclude_on_hold": exc_hold,
            "milestone_filter": "zero_value",
            "is_zero_mode": True,
            "summary": {
                "total_active_items": len(evaluated_items),
                "total_raw_items": len(raw_items),
                "on_hold_excluded": sum(1 for x in (zero_value_items or []) if x.get("on_hold")) if exc_hold else 0,
                "overdue_items_count": len(zero_enriched_items),
                "all_overdue_items_count": all_overdue_items_unfiltered_count,
                "overdue_milestones_total": len(zero_enriched_items),
                "all_overdue_milestones_total": sum(milestone_counts.values()),
                "milestone_breakdown": milestone_counts,
                "zero_value_count": len(active_zero_items),
                "zero_value_scanned": zero_value_scanned,
                "zero_value_released_count": sum(1 for z in active_zero_items if z.get("released")),
                "zero_value_unreleased_count": sum(1 for z in active_zero_items if not z.get("released")),
                "recipients_to_email": len(packets),
                "due_soon_days": due_soon_days,
                "due_soon_count": 0,
                "due_soon_milestones_total": 0,
                "due_soon_3d_count": 0,
            },
            "items": zero_enriched_items,
            "overdue_items": zero_enriched_items,
            "due_soon_items": [],
            "packets": packets,
        }

    # Standard Date-Overdue Packet Builder
    overdue_items.sort(key=lambda x: (-x["max_days_overdue"], int(x["qkey"])))

    packets = []
    if grouping_mode == "per_item":
        for it in overdue_items:
            to_emails: list[str] = []
            recipient_names: list[str] = []
            for r in it["notify_recipients"]:
                if not r["active"]:
                    continue
                recipient_names.append(f"{r['name']} ({r['role']})")
                if r["email"] and r["email"] not in to_emails:
                    to_emails.append(r["email"])
            if not to_emails:
                continue
            packets.append(
                {
                    "packet_id": f"item:{it['qkey']}",
                    "packet_kind": "overdue",
                    "recipient_name": ", ".join(recipient_names),
                    "role": "DPM & PS" if it["has_ps_overdue"] else "DPM",
                    "to_emails": to_emails,
                    "item_count": 1,
                    "milestone_count": len(it["overdue_milestones"]),
                    "qkeys": [it["qkey"]],
                    "items": [
                        {
                            **it,
                            "relevant_milestones": it["overdue_milestones"],
                        }
                    ],
                }
            )
    else:
        buckets: dict[str, dict] = {}
        for it in overdue_items:
            dpm_name = it["dpm"]
            ps_name = it["ps"]
            dpm_email, dpm_active = resolve_person(dpm_name)
            ps_email, ps_active = resolve_person(ps_name)

            same_person = dpm_name.strip().lower() == ps_name.strip().lower()

            if dpm_active and dpm_email:
                b_key = f"dpm:{dpm_name.strip().lower()}"
                if b_key not in buckets:
                    buckets[b_key] = {
                        "packet_id": b_key,
                        "packet_kind": "overdue",
                        "person_name": dpm_name,
                        "role": "DPM",
                        "to_emails": [dpm_email],
                        "items": [],
                    }
                if same_person and it["has_ps_overdue"]:
                    buckets[b_key]["role"] = "DPM & PS"
                buckets[b_key]["items"].append(
                    {
                        **it,
                        "relevant_milestones": it["overdue_milestones"],
                    }
                )

            if it["has_ps_overdue"] and not same_person and ps_active and ps_email:
                b_key = f"ps:{ps_name.strip().lower()}"
                ps_ms = [m for m in it["overdue_milestones"] if m["notify_ps"]]
                ps_role_labels = sorted({m["label"] for m in ps_ms})
                role_label = f"PS ({' & '.join(ps_role_labels)})" if ps_role_labels else "PS"
                if b_key not in buckets:
                    buckets[b_key] = {
                        "packet_id": b_key,
                        "packet_kind": "overdue",
                        "person_name": ps_name,
                        "role": role_label,
                        "to_emails": [ps_email],
                        "items": [],
                    }
                else:
                    existing_r = buckets[b_key]["role"]
                    for lbl in ps_role_labels:
                        if lbl not in existing_r:
                            buckets[b_key]["role"] = "PS (Field Measurements & PS Request)"
                buckets[b_key]["items"].append(
                    {
                        **it,
                        "relevant_milestones": ps_ms,
                    }
                )

        for b in sorted(buckets.values(), key=lambda x: (0 if x["role"].startswith("DPM") else 1, x["person_name"].lower())):
            total_m = sum(len(x["relevant_milestones"]) for x in b["items"])
            packets.append(
                {
                    "packet_id": b["packet_id"],
                    "packet_kind": "overdue",
                    "recipient_name": f"{b['person_name']} ({b['role']})",
                    "person_name": b["person_name"],
                    "role": b["role"],
                    "to_emails": b["to_emails"],
                    "item_count": len(b["items"]),
                    "milestone_count": total_m,
                    "qkeys": [x["qkey"] for x in b["items"]],
                    "items": b["items"],
                }
            )

    active_ms_total = (
        milestone_counts.get(ms_filter, 0) if ms_filter else sum(milestone_counts.values())
    )

    return {
        "as_of_date": ref_date.isoformat(),
        "as_of_display": ref_date.strftime("%m/%d/%Y"),
        "include_due_today": inc_today,
        "exclude_on_hold": exc_hold,
        "milestone_filter": ms_filter,
        "is_zero_mode": False,
        "summary": {
            "total_active_items": len(evaluated_items),
            "total_raw_items": len(raw_items),
            "on_hold_excluded": sum(1 for x in raw_items if x.get("on_hold")) if exc_hold else 0,
            "overdue_items_count": len(overdue_items),
            "all_overdue_items_count": all_overdue_items_unfiltered_count,
            "overdue_milestones_total": active_ms_total,
            "all_overdue_milestones_total": sum(milestone_counts.values()),
            "milestone_breakdown": milestone_counts,
            "zero_value_count": len(active_zero_items),
            "zero_value_scanned": zero_value_scanned,
            "zero_value_released_count": sum(1 for z in active_zero_items if z.get("released")),
            "zero_value_unreleased_count": sum(1 for z in active_zero_items if not z.get("released")),
            "recipients_to_email": len(packets),
            "due_soon_days": due_soon_days,
            "due_soon_count": due_soon_count,
            "due_soon_milestones_total": due_soon_milestones_total,
            "due_soon_3d_count": due_soon_count,
        },
        "items": evaluated_items,
        "overdue_items": overdue_items,
        "due_soon_items": due_soon_items,
        "packets": packets,
    }

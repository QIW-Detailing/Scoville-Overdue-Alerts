const FRONTEND_APP_VERSION = 16;
const IS_GITHUB_PAGES =
  window.location.protocol === "https:" || window.location.hostname.endsWith("github.io");
const IS_REMOTE_CLIENT =
  !IS_GITHUB_PAGES && !["127.0.0.1", "localhost", ""].includes(window.location.hostname);

const API_BASE = IS_GITHUB_PAGES ? "http://127.0.0.1:5055" : "";

function apiFetch(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, opts);
}

const state = {
  staticMode: false,
  rawSnapshot: null,
  today: "",
  syncedAt: null,
  milestones: [],
  evaluation: null,
  directory: [],
  settings: {
    scoville_url: "http://scoville:7555",
    email_subject: "Overdues on Scoville",
    zero_value_subject: "$0 Items on Scoville",
    bom_email_subject: "Missing BOM Email",
    bom_grace_hours: 2,
    default_recipient_email: "akanday@qiworks.com",
    grouping_mode: "digest",
    delivery_mode: "outlook_eml",
  },
  effectiveSender: "This PC's Local Outlook",
  logs: [],
  activeTab: "dashboard",
  activeSubview: "packets",
  selectedMilestone: "",
  dueSoonDays: 7,
  dueSoonPreset: "7",
  previewPacketId: null,
};

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toast(msg, type = "info") {
  const box = document.getElementById("toastContainer");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4800);
}

function deliveryLabel(mode) {
  switch (mode) {
    case "outlook_send":
      return "Outlook Send";
    case "outlook_draft":
      return "Outlook Drafts";
    case "smtp":
      return "SMTP Server";
    case "dry_run":
      return "Dry-Run (Log Only)";
    default:
      return mode;
  }
}

function addDaysIso(baseIso, days) {
  const [y, m, d] = baseIso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function currentEvalParams() {
  const asOf = document.getElementById("asOfDateInput").value || state.today || "";
  const incToday = document.getElementById("chkIncludeDueToday").checked;
  const excHold = document.getElementById("chkExcludeOnHold").checked;
  return {
    as_of: asOf,
    include_due_today: incToday,
    exclude_on_hold: excHold,
    milestone: state.selectedMilestone || "",
    due_soon_days: state.dueSoonDays || 7,
  };
}

function localTodayIso() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

async function loadStaticSnapshotFallback(preserveDate = false) {
  const dot = document.getElementById("syncStatusDot");
  if (!state.rawSnapshot) {
    const snapRes = await fetch(`./snapshot.json?t=${Date.now()}`);
    if (!snapRes.ok) throw new Error("Snapshot not found");
    state.rawSnapshot = await snapRes.json();
  }

  state.staticMode = true;
  state.today = localTodayIso();
  state.syncedAt = state.rawSnapshot.synced_at || null;
  state.milestones = state.rawSnapshot.milestones || [];

  let savedDir = null;
  try {
    savedDir = JSON.parse(localStorage.getItem("scoville_dir_override") || "null");
  } catch (_) {}
  state.directory = Array.isArray(savedDir) && savedDir.length ? savedDir : (state.rawSnapshot.directory || []);
  state.effectiveSender = "This PC's Local Outlook (.eml)";

  if (!preserveDate) {
    document.getElementById("asOfDateInput").value = state.today;
    document.getElementById("chkIncludeDueToday").checked = false;
    document.getElementById("chkExcludeOnHold").checked = true;
  }

  state.evaluation = window.ScovilleStandalone.evaluateSnapshot(
    state.rawSnapshot,
    state.directory,
    state.settings,
    currentEvalParams()
  );

  const dlBtn = document.getElementById("btnDownloadHelper");
  if (dlBtn) dlBtn.style.display = "inline-flex";
  document.getElementById("outdatedHelperBanner")?.classList.add("hidden");

  dot.className = "dot";
  document.getElementById("lastSyncText").textContent = state.syncedAt
    ? `Snapshot: ${state.syncedAt.replace("T", " ")}`
    : "Snapshot loaded";

  renderAll();
}

async function loadState(preserveDate = false) {
  const dot = document.getElementById("syncStatusDot");
  dot.className = "dot syncing";

  // If already in standalone snapshot mode and merely filtering, evaluate instantly in memory!
  if (state.staticMode && preserveDate && state.rawSnapshot) {
    state.evaluation = window.ScovilleStandalone.evaluateSnapshot(
      state.rawSnapshot,
      state.directory,
      state.settings,
      currentEvalParams()
    );
    dot.className = "dot";
    renderAll();
    return;
  }

  try {
    let url = "/api/state";
    if (preserveDate) {
      const p = currentEvalParams();
      const qs = new URLSearchParams({
        as_of: p.as_of,
        include_due_today: String(p.include_due_today),
        exclude_on_hold: String(p.exclude_on_hold),
        milestone: p.milestone,
        due_soon_days: String(p.due_soon_days),
      });
      url += `?${qs.toString()}`;
    } else if (state.dueSoonDays && state.dueSoonDays !== 7) {
      url += `?due_soon_days=${encodeURIComponent(state.dueSoonDays)}`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IS_GITHUB_PAGES ? 2500 : 30000);
    const res = await apiFetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed to load state");

    state.staticMode = false;
    state.needsCredentials = Boolean(data.needs_credentials);
    const serverVer = Number(data.app_version || 0);
    const dlBtn = document.getElementById("btnDownloadHelper");
    if (dlBtn) {
      dlBtn.style.display = "inline-flex";
      if (serverVer < FRONTEND_APP_VERSION) {
        dlBtn.innerHTML = "&#x2B06; Update PC Helper (.zip)";
        dlBtn.title = "A newer version of the PC Helper is available — click to download & run Setup-This-PC";
      } else {
        dlBtn.innerHTML = "&#x2B07; PC Live-Sync Helper (.zip)";
        dlBtn.title = "Download the PC Live-Sync Helper (.zip) for another computer or to reinstall";
      }
    }
    const outdatedBanner = document.getElementById("outdatedHelperBanner");
    if (outdatedBanner) {
      outdatedBanner.classList.toggle("hidden", serverVer >= FRONTEND_APP_VERSION);
    }

    state.today = data.today;
    state.syncedAt = data.synced_at;
    state.milestones = data.milestones || [];
    state.evaluation = data.evaluation;
    state.directory = data.directory || [];
    state.settings = data.settings || {};
    state.effectiveSender = data.effective_sender || "Local Outlook Account";
    state.logs = data.logs || [];

    if (!preserveDate) {
      document.getElementById("asOfDateInput").value = state.evaluation.as_of_date || state.today;
      document.getElementById("chkIncludeDueToday").checked = Boolean(state.evaluation.include_due_today);
      document.getElementById("chkExcludeOnHold").checked = Boolean(state.evaluation.exclude_on_hold);
    }

    if (data.needs_credentials && !preserveDate) {
      dot.className = "dot syncing";
      document.getElementById("lastSyncText").textContent = "Enter Scoville login in Settings";
      renderAll();
      document.querySelector('.tab-btn[data-tab="settings"]')?.click();
      document.getElementById("setScovilleEmail")?.focus();
      toast("Welcome! Enter your Scoville email & password below and click Save All Settings.", "info");
      return;
    }

    if (!preserveDate && window.location.hash === "#settings") {
      document.querySelector('.tab-btn[data-tab="settings"]')?.click();
    }

    if (data.sync_error) {
      dot.className = "dot error";
      document.getElementById("lastSyncText").textContent = "Sync error — check Settings";
      toast(data.sync_error, "err");
    } else {
      dot.className = "dot";
      document.getElementById("lastSyncText").textContent = state.syncedAt
        ? `Last Sync: ${state.syncedAt.replace("T", " ")}`
        : "Not synced yet";
    }

    renderAll();
  } catch (err) {
    if (IS_GITHUB_PAGES && window.ScovilleStandalone) {
      try {
        await loadStaticSnapshotFallback(preserveDate);
        return;
      } catch (snapErr) {
        // fall through
      }
    }
    dot.className = "dot error";
    document.getElementById("lastSyncText").textContent = "Scoville service offline";
    toast(err.message || "Connection error", "err");
  }
}

async function triggerScovilleSync() {
  if (state.staticMode) {
    // Re-check if the user just launched Setup-This-PC.bat / Scoville Overdue Alerts shortcut on their PC!
    state.staticMode = false;
    await loadState(true);
    if (state.staticMode) {
      toast(
        "Local helper (127.0.0.1:5055) is not running yet. Extract the .zip, double-click Setup-This-PC.bat, or open http://127.0.0.1:5055 directly!",
        "info"
      );
    } else {
      toast("Connected to your PC Helper! Syncing live from Scoville...", "ok");
      await triggerScovilleSync();
    }
    return;
  }

  const btn = document.getElementById("btnSyncNow");
  const dot = document.getElementById("syncStatusDot");
  btn.disabled = true;
  btn.textContent = "Syncing...";
  dot.className = "dot syncing";
  document.getElementById("lastSyncText").textContent = "Syncing live from Scoville...";

  try {
    const res = await apiFetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentEvalParams()),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Scoville sync failed");

    state.syncedAt = data.synced_at;
    state.evaluation = data.evaluation;
    state.directory = data.directory;
    dot.className = "dot";
    document.getElementById("lastSyncText").textContent = `Last Sync: ${state.syncedAt.replace("T", " ")}`;
    renderAll();
    toast(`Synced ${state.evaluation.summary.total_raw_items} items from Scoville.`, "ok");
  } catch (err) {
    dot.className = "dot error";
    document.getElementById("lastSyncText").textContent = "Sync failed";
    toast(friendlyFetchError(err), "err");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "&#x21bb; Sync Scoville Now";
  }
}

function renderAll() {
  renderHeaderAndKPIs();
  populateFilterDropdowns();
  renderMilestoneStrip();
  renderPackets();
  renderItemsTable();
  renderDirectory();
  renderLogs();
  populateSettingsForm();
}

function renderHeaderAndKPIs() {
  const s = state.settings;
  const ev = state.evaluation;
  if (!ev) return;

  document.getElementById("hdrFromEmail").textContent = state.effectiveSender || "Local Outlook Account";
  document.getElementById("hdrSubject").textContent = s.email_subject || "Overdues on Scoville";
  document.getElementById("openScovilleLink").href = `${(s.scoville_url || "http://scoville:7555").replace(/\/$/, "")}/admin/hot`;
  document.getElementById("activeDeliveryBadge").textContent = `Mode: ${deliveryLabel(s.delivery_mode)}`;

  const sum = ev.summary;
  const isZero = state.selectedMilestone === "zero_value";
  const isBom = state.selectedMilestone === "missing_bom";
  const dDays = state.dueSoonDays || sum.due_soon_days || 7;
  const dayWord = dDays === 1 ? "Day" : "Days";
  const dueSoonTitle = `Due Next ${dDays} ${dayWord}`;

  const dueLblEl = document.getElementById("kpiDueSoonLabel");
  if (dueLblEl) dueLblEl.textContent = dueSoonTitle;
  const segDueBtn = document.getElementById("segBtnDueSoon");
  if (segDueBtn) segDueBtn.textContent = dueSoonTitle;

  if (isZero) {
    document.getElementById("kpiTotalItems").textContent = sum.zero_value_scanned || 0;
    document.getElementById("kpiOnHoldNote").textContent =
      `Scanned $0 items (${sum.zero_value_unreleased_count || 0} unreleased, ${sum.zero_value_released_count || 0} released caught)`;
    document.getElementById("kpiOverdueItems").textContent = sum.overdue_items_count;
    document.getElementById("kpiOverdueMilestones").textContent =
      `$0 items w/ real scope values available (separate from All)`;
    document.getElementById("kpiPacketsCount").textContent = sum.recipients_to_email;
    document.getElementById("kpiDueSoon").textContent = "—";
    const dueFootEl = document.getElementById("kpiDueSoonFoot");
    if (dueFootEl) dueFootEl.textContent = "Click to switch to schedule items";
  } else if (isBom) {
    const graceH = sum.bom_grace_hours || 2;
    document.getElementById("kpiTotalItems").textContent = sum.missing_bom_scanned || 0;
    document.getElementById("kpiOnHoldNote").textContent =
      `Tekla-linked since 11/24 (${sum.missing_bom_verified_count || 0} BOM sent, ${sum.missing_bom_within_grace_count || 0} <${graceH}h grace)`;
    document.getElementById("kpiOverdueItems").textContent = sum.overdue_items_count;
    document.getElementById("kpiOverdueMilestones").textContent =
      `Linked >${graceH}h ago w/o BOM email in Detailing Mailbox (separate from All)`;
    document.getElementById("kpiPacketsCount").textContent = sum.recipients_to_email;
    document.getElementById("kpiDueSoon").textContent = "—";
    const dueFootEl = document.getElementById("kpiDueSoonFoot");
    if (dueFootEl) dueFootEl.textContent = "Click to switch to schedule items";
  } else {
    document.getElementById("kpiTotalItems").textContent = sum.total_active_items;
    document.getElementById("kpiOnHoldNote").textContent =
      sum.on_hold_excluded > 0
        ? `${sum.on_hold_excluded} On-Hold items skipped`
        : `Out of ${sum.total_raw_items} unreleased items`;

    const activeMsObj = state.milestones.find((m) => m.key === state.selectedMilestone);
    const msDesc = activeMsObj ? `${activeMsObj.label} dates` : "schedule dates";
    document.getElementById("kpiOverdueItems").textContent = sum.overdue_items_count;
    document.getElementById("kpiOverdueMilestones").textContent = `${sum.overdue_milestones_total} missed ${msDesc} (as of ${ev.as_of_display})`;
    document.getElementById("kpiPacketsCount").textContent = sum.recipients_to_email;
    const dueCnt = sum.due_soon_count ?? sum.due_soon_3d_count ?? 0;
    const dueMsCnt = sum.due_soon_milestones_total ?? dueCnt;
    document.getElementById("kpiDueSoon").textContent = dueCnt;
    const dueFootEl = document.getElementById("kpiDueSoonFoot");
    if (dueFootEl) {
      dueFootEl.textContent = `${dueMsCnt} upcoming ${msDesc} (click to view)`;
    }
  }

  document.querySelectorAll(".kpi-card[data-kpi-subview]").forEach((card) => {
    card.classList.toggle(
      "active-kpi",
      card.getAttribute("data-kpi-subview") === state.activeSubview
    );
  });

  document.getElementById("tabOverdueCount").textContent = sum.all_overdue_items_count ?? sum.overdue_items_count;
  document.getElementById("tabDirCount").textContent = state.directory.length;
  document.getElementById("tabLogsCount").textContent = state.logs.length;
}

function populateFilterDropdowns() {
  if (!state.evaluation) return;
  const items = state.evaluation.items || [];
  const dpmSelect = document.getElementById("filterDpm");
  const psSelect = document.getElementById("filterPs");
  const prevDpm = dpmSelect.value;
  const prevPs = psSelect.value;

  const dpms = [...new Set(items.map((i) => i.dpm).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const pss = [...new Set(items.map((i) => i.ps).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  dpmSelect.innerHTML = `<option value="">All DPMs (${dpms.length})</option>` +
    dpms.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  psSelect.innerHTML = `<option value="">All PSs (${pss.length})</option>` +
    pss.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");

  if (dpms.includes(prevDpm)) dpmSelect.value = prevDpm;
  if (pss.includes(prevPs)) psSelect.value = prevPs;
}

function renderMilestoneStrip() {
  const strip = document.getElementById("milestoneBreakdownStrip");
  if (!state.evaluation) return;
  const sum = state.evaluation.summary;
  const bd = sum.milestone_breakdown || {};
  const allTotal = sum.all_overdue_milestones_total ?? sum.overdue_milestones_total ?? 0;
  const zeroCnt = sum.zero_value_count ?? 0;
  const bomCnt = sum.missing_bom_count ?? 0;
  const bomGrace = sum.bom_grace_hours || 2;

  const allChipHtml = `
    <div class="ms-chip ${state.selectedMilestone === "" ? "active" : ""}" data-ms="" title="Show all overdue schedule dates (excludes $0 Items)">
      <span>All</span>
      <span class="count ${allTotal > 0 ? "hot" : ""}">${allTotal}</span>
    </div>
  `;

  const chipsHtml = state.milestones
    .map((m) => {
      const cnt = bd[m.key] || 0;
      const active = state.selectedMilestone === m.key ? "active" : "";
      const routeTag = m.notify_ps ? "DPM + PS" : "DPM";
      const extraTag = m.key === "ps_request" ? " · Not in Tekla" : "";
      return `
        <div class="ms-chip ${active}" data-ms="${esc(m.key)}" title="Show ONLY ${esc(m.label)} overdues">
          <span>${esc(m.label)} <small style="color:#64748b;">(${routeTag}${extraTag})</small></span>
          <span class="count ${cnt > 0 ? "hot" : ""}">${cnt}</span>
        </div>
      `;
    })
    .join("");

  const zeroChipHtml = `
    <div class="ms-divider" title="$0 Items & Missing BOM are tracked separately and excluded from All"></div>
    <div class="ms-chip zero-chip ${state.selectedMilestone === "zero_value" ? "active" : ""}" data-ms="zero_value" title="Separate view: $0 items (released & unreleased) that have real job scope values available to assign (DPM only)">
      <span>$0 Items <small style="color:#6366f1;">(DPM &middot; Separate)</small></span>
      <span class="count ${zeroCnt > 0 ? "zero-hot" : ""}">${zeroCnt}</span>
    </div>
    <div class="ms-chip bom-chip ${state.selectedMilestone === "missing_bom" ? "active" : ""}" data-ms="missing_bom" title="Separate view: Tekla-linked items (> ${bomGrace}h) with no matching BOM email in Detailing Mailbox (DPM only)">
      <span>Missing BOM <small style="color:#9a3412;">(DPM &middot; &gt;${bomGrace}h)</small></span>
      <span class="count ${bomCnt > 0 ? "bom-hot" : ""}">${bomCnt}</span>
    </div>
  `;

  strip.innerHTML = allChipHtml + chipsHtml + zeroChipHtml;

  strip.querySelectorAll(".ms-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const key = chip.getAttribute("data-ms") || "";
      if (state.selectedMilestone === key && key !== "") {
        state.selectedMilestone = "";
      } else {
        state.selectedMilestone = key;
      }
      loadState(true);
    });
  });
}

function getActiveFilters() {
  return {
    dpm: document.getElementById("filterDpm").value,
    ps: document.getElementById("filterPs").value,
    search: document.getElementById("filterSearch").value.trim().toLowerCase(),
    milestone: state.selectedMilestone,
  };
}

function itemMatchesFilters(it, f, viewMode = "overdue") {
  if (f.dpm && it.dpm !== f.dpm) return false;
  if (f.ps && it.ps !== f.ps) return false;
  if (f.milestone === "zero_value") {
    if (!it.is_zero_value_item) return false;
  } else if (f.milestone === "missing_bom") {
    if (!it.is_missing_bom_item) return false;
  } else if (f.milestone) {
    const ms = it.milestones?.[f.milestone];
    if (viewMode === "due-soon-table") {
      if (!ms || !ms.is_due_soon) return false;
    } else if (viewMode === "all-table") {
      if (!ms) return false;
    } else {
      if (!ms || !ms.is_overdue) return false;
    }
  }
  if (f.search) {
    const recEmails = (it.notify_recipients || []).map((r) => r.email || "").join(" ");
    const hay = `${it.qkey} ${it.job_number} ${it.job_site} ${it.category} ${it.sub_category} ${it.dpm} ${it.ps} ${it.lot_number || ""} ${recEmails}`.toLowerCase();
    if (!hay.includes(f.search)) return false;
  }
  return true;
}

function renderPackets() {
  const container = document.getElementById("packetsContainer");
  if (!state.evaluation) return;
  const f = getActiveFilters();
  const hasClientFilter = Boolean(f.dpm || f.ps || f.search);

  const packets = (state.evaluation.packets || [])
    .map((pkt) => {
      const matchingItems = pkt.items
        .filter((it) => itemMatchesFilters(it, f))
        .map((it) => ({
          ...it,
          relevant_milestones: (it.relevant_milestones || []).filter(
            (m) => !f.milestone || m.key === f.milestone
          ),
        }))
        .filter((it) => it.relevant_milestones.length > 0);

      return {
        ...pkt,
        items: matchingItems,
        item_count: matchingItems.length,
      };
    })
    .filter((pkt) => pkt.items.length > 0);

  document.getElementById("btnSendAll").disabled = packets.length === 0;
  document.getElementById("btnDraftAll").disabled = packets.length === 0;

  if (packets.length === 0) {
    const isToday = state.evaluation.as_of_date === state.today;
    const msObj = state.milestones.find((m) => m.key === state.selectedMilestone);
    const msLabel =
      state.selectedMilestone === "zero_value"
        ? "$0 Value"
        : state.selectedMilestone === "missing_bom"
        ? "Missing BOM"
        : msObj
        ? msObj.label
        : "Schedule";
    container.innerHTML = `
      <div class="empty-state">
        <h3>No ${esc(msLabel)} Items Found</h3>
        <p>
          ${
            hasClientFilter
              ? `No items match your active search / filter${f.search ? ` ("${esc(f.search)}")` : ""}.`
              : state.selectedMilestone === "missing_bom"
              ? "All Tekla-linked items (>2h since 11/24/2026) have matching BOM emails recorded!"
              : isToday && !state.selectedMilestone
              ? "Great news — 0 items have missed dates strictly before today in Scoville."
              : "No items match your current selection / filter."
          }
        </p>
        <div class="inline-row" style="justify-content:center;">
          ${hasClientFilter ? `<button type="button" class="btn btn-primary" id="emptyBtnClearFilters">Clear Search &amp; Filters</button>` : ""}
          ${state.selectedMilestone === "missing_bom" && !state.staticMode ? `<button type="button" class="btn btn-outline" id="emptyBtnRescanBom">&#x21bb; Re-check Detailing Mailbox</button>` : ""}
          ${state.selectedMilestone ? `<button type="button" class="btn btn-outline" id="emptyBtnShowAll">Back to All Overdues</button>` : ""}
          ${!state.selectedMilestone ? `<button type="button" class="btn btn-outline" id="emptyBtnDueToday">Include Items Due Today</button>` : ""}
          ${!state.selectedMilestone ? `<button type="button" class="btn btn-outline" id="emptyBtnPlus7">Simulate +7 Days Out</button>` : ""}
        </div>
      </div>
    `;
    document.getElementById("emptyBtnRescanBom")?.addEventListener("click", rescanBomMailbox);
    document.getElementById("emptyBtnClearFilters")?.addEventListener("click", () => {
      document.getElementById("filterSearch").value = "";
      document.getElementById("filterDpm").value = "";
      document.getElementById("filterPs").value = "";
      renderPackets();
      renderItemsTable();
    });
    document.getElementById("emptyBtnShowAll")?.addEventListener("click", () => {
      state.selectedMilestone = "";
      loadState(true);
    });
    document.getElementById("emptyBtnDueToday")?.addEventListener("click", () => {
      document.getElementById("chkIncludeDueToday").checked = true;
      loadState(true);
    });
    document.getElementById("emptyBtnPlus7")?.addEventListener("click", () => {
      document.getElementById("asOfDateInput").value = addDaysIso(state.today, 7);
      loadState(true);
    });
    return;
  }

  container.innerHTML = packets
    .map((pkt) => {
      const isPs = pkt.role.startsWith("PS");
      const isZeroPkt = pkt.packet_kind === "zero_value";
      const isBomPkt = pkt.packet_kind === "missing_bom";
      const countCls = isZeroPkt ? "badge-zero" : isBomPkt ? "badge-bom" : "badge-overdue";

      const itemsHtml = pkt.items
        .map((it) => {
          const itemUrl = isZeroPkt ? (it.forecast_url || it.edit_url) : it.edit_url;
          const badges = (it.relevant_milestones || [])
            .map((m) => {
              if (m.is_zero_value) {
                return `<span class="badge badge-zero" title="${esc((m.sample_scopes || []).join(' | '))}">${esc(m.release_status)} &middot; ${esc(m.display)}</span>`;
              }
              if (m.is_missing_bom) {
                const markBtn = !state.staticMode
                  ? ` <button type="button" class="btn btn-xs btn-ghost" data-mark-bom-job="${esc(it.job_number)}" data-mark-bom-lot="${esc(it.lot_number)}" title="Mark Lot #${esc(it.lot_number)} as BOM Sent">&#x2713; Sent</button>`
                  : "";
                return `<span class="badge badge-bom" title="Linked: ${esc(m.linked_display || '')}">${esc(m.display)}</span>${markBtn}`;
              }
              const cls = m.is_field_dims ? "badge-fm-overdue" : "badge-overdue";
              const dTag = m.days_overdue === 0 ? "Today" : `${m.days_overdue}d`;
              return `<span class="badge ${cls}">${esc(m.short)}: ${esc(m.display)} (${dTag})</span>`;
            })
            .join("");
          return `
            <div class="pkt-item-row">
              <div>
                <a class="pkt-qkey" href="${esc(itemUrl)}" target="_blank" rel="noopener">QKEY ${esc(it.qkey)}</a>
                <span style="color:#334155;"> &mdash; ${esc(it.job_number)} ${esc(it.job_site)}</span>
                <div style="font-size:11px;color:#64748b;">DPM: ${esc(it.dpm)} &middot; PS: ${esc(it.ps)}</div>
              </div>
              <div class="pkt-badges">${badges}</div>
            </div>
          `;
        })
        .join("");

      return `
        <div class="packet-card">
          <div class="packet-top">
            <div>
              <h4 class="packet-title">
                ${esc(pkt.person_name || pkt.recipient_name)}
                <span class="role-tag ${isPs ? "ps" : ""}">${esc(pkt.role)}</span>
              </h4>
              <div class="packet-email">To: <strong>${esc(pkt.to_emails.join(", "))}</strong></div>
            </div>
            <span class="badge ${countCls}">${pkt.item_count} item${pkt.item_count === 1 ? "" : "s"}</span>
          </div>
          <div class="packet-items-list">${itemsHtml}</div>
          <div class="packet-actions">
            <button class="btn btn-xs btn-outline" data-preview="${esc(pkt.packet_id)}">Preview Email</button>
            ${
              state.staticMode
                ? `<button class="btn btn-xs ${isZeroPkt ? "btn-primary" : "btn-danger"}" data-eml="${esc(pkt.packet_id)}" title="Open ready-to-send email in THIS computer's local Microsoft Outlook">&#x2709; Open in My Outlook</button>`
                : IS_REMOTE_CLIENT
                ? `<button class="btn btn-xs btn-outline" data-eml="${esc(pkt.packet_id)}">Open in My Outlook</button><button class="btn btn-xs ${isZeroPkt ? "btn-primary" : "btn-danger"}" data-send="${esc(pkt.packet_id)}">&#x2709; Send Email</button>`
                : `<button class="btn btn-xs btn-outline" data-draft="${esc(pkt.packet_id)}">Save Outlook Draft</button><button class="btn btn-xs ${isZeroPkt ? "btn-primary" : "btn-danger"}" data-send="${esc(pkt.packet_id)}">&#x2709; Send Email</button>`
            }
          </div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll("[data-preview]").forEach((b) =>
    b.addEventListener("click", () => openPreviewModal(b.getAttribute("data-preview")))
  );
  container.querySelectorAll("[data-draft]").forEach((b) =>
    b.addEventListener("click", () => sendPackets([b.getAttribute("data-draft")], "outlook_draft"))
  );
  container.querySelectorAll("[data-eml]").forEach((b) =>
    b.addEventListener("click", () => downloadEml(b.getAttribute("data-eml")))
  );
  container.querySelectorAll("[data-send]").forEach((b) =>
    b.addEventListener("click", () => sendPackets([b.getAttribute("data-send")], null))
  );
  container.querySelectorAll("[data-mark-bom-job]").forEach((b) =>
    b.addEventListener("click", () =>
      markBomSent(b.getAttribute("data-mark-bom-job"), b.getAttribute("data-mark-bom-lot"))
    )
  );
}

async function rescanBomMailbox() {
  try {
    toast("Scanning Detailing Mailbox in Outlook...", "info");
    const res = await apiFetch("/api/bom/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentEvalParams()),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "BOM mailbox scan failed");
    state.evaluation = data.evaluation;
    renderAll();
    const s = data.scan || {};
    toast(
      `Checked ${s.scanned_messages || 0} BOM emails (${s.newly_recorded || 0} newly recorded).`,
      "ok"
    );
  } catch (err) {
    toast(friendlyFetchError(err), "err");
  }
}

async function markBomSent(jobNumber, lotNumber) {
  try {
    const res = await apiFetch("/api/bom/mark-sent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_number: jobNumber,
        lot_number: lotNumber,
        ...currentEvalParams(),
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed marking BOM sent");
    state.evaluation = data.evaluation;
    renderAll();
    toast(`Marked Job ${jobNumber} Lot #${lotNumber} as BOM Sent!`, "ok");
  } catch (err) {
    toast(friendlyFetchError(err), "err");
  }
}

function packetSubject(pkt) {
  if (pkt.packet_kind === "zero_value") {
    return state.settings.zero_value_subject || "$0 Items on Scoville";
  }
  if (pkt.packet_kind === "missing_bom") {
    return state.settings.bom_email_subject || "Missing BOM Email";
  }
  return state.settings.email_subject || "Overdues on Scoville";
}

async function downloadEml(packetId) {
  if (state.staticMode && window.ScovilleStandalone) {
    const pkt = (state.evaluation?.packets || []).find((p) => p.packet_id === packetId);
    if (!pkt) return toast("Packet not found.", "err");
    const subj = packetSubject(pkt);
    window.ScovilleStandalone.downloadPacketEml(
      pkt,
      subj,
      state.settings.cc_emails || "",
      state.evaluation.as_of_display
    );
    toast("Opened .eml download — click it to open in your PC's Outlook!", "ok");
    document.getElementById("previewModal").classList.add("hidden");
    return;
  }

  try {
    const res = await apiFetch("/api/eml", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packet_id: packetId, ...currentEvalParams() }),
    });
    if (!res.ok) throw new Error("Failed generating .eml file");
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const m = cd.match(/filename="([^"]+)"/);
    const filename = m ? m[1] : "Scoville_Overdue.eml";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Downloaded .eml — click it to open in this computer's Outlook!", "ok");
  } catch (err) {
    toast(err.message, "err");
  }
}

function renderMilestoneBadge(m) {
  if (!m) return `<span class="badge-none">—</span>`;
  if (m.status === "completed") {
    return `<span class="badge badge-ok">&#x2713; ${esc(m.display === "Completed" ? "Done" : m.display)}</span>`;
  }
  if (m.status === "unscheduled") {
    return `<span class="badge-none">Unscheduled</span>`;
  }
  if (m.is_overdue) {
    const cls = m.is_field_dims ? "badge-fm-overdue" : "badge-overdue";
    const tag = m.days_overdue === 0 ? "Due Today" : `${m.days_overdue}d late`;
    return `<span class="badge ${cls}">${esc(m.display)} (${tag})</span>`;
  }
  if (m.is_due_soon) {
    const rem =
      m.days_until === 0
        ? "Today"
        : m.days_until !== null && m.days_until !== undefined
        ? `in ${m.days_until}d`
        : "";
    return `<span class="badge badge-soon">${esc(m.display)}${rem ? ` (${rem})` : ""}</span>`;
  }
  return `<span class="badge badge-sched">${esc(m.display)}</span>`;
}

function setActiveSubview(subviewName) {
  state.activeSubview = subviewName;
  document.querySelectorAll(".seg-btn").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-subview") === subviewName);
  });
  document.querySelectorAll(".kpi-card[data-kpi-subview]").forEach((card) => {
    card.classList.toggle("active-kpi", card.getAttribute("data-kpi-subview") === subviewName);
  });

  if (
    subviewName === "due-soon-table" &&
    (state.selectedMilestone === "zero_value" || state.selectedMilestone === "missing_bom")
  ) {
    state.selectedMilestone = "";
    loadState(true);
  }

  if (subviewName === "packets") {
    document.getElementById("subview-packets").classList.add("active");
    document.getElementById("subview-table").classList.remove("active");
  } else {
    document.getElementById("subview-packets").classList.remove("active");
    document.getElementById("subview-table").classList.add("active");
    renderItemsTable();
  }
}

function renderItemsTable() {
  const theadRow = document.getElementById("itemsTableHeadRow");
  const tbody = document.getElementById("itemsTableBody");
  const dueToolbar = document.getElementById("dueSoonToolbar");
  if (!state.evaluation) return;
  const f = getActiveFilters();

  if (dueToolbar) {
    dueToolbar.classList.toggle("hidden", state.activeSubview !== "due-soon-table");
  }

  if (f.milestone === "missing_bom") {
    theadRow.innerHTML =
      `<th>QKEY / Lot #</th>` +
      `<th>Job # &amp; Site</th>` +
      `<th>Category / Sub Category</th>` +
      `<th>DPM / PS</th>` +
      `<th>Tekla Link Time &amp; Status</th>` +
      `<th>Actions</th>`;

    const filteredBom = (state.evaluation.items || []).filter((it) =>
      itemMatchesFilters(it, f, state.activeSubview)
    );
    if (filteredBom.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:28px;color:#64748b;">No Tekla-linked items (&gt;2h) are missing a BOM email.</td></tr>`;
      return;
    }

    tbody.innerHTML = filteredBom
      .map((it) => {
        const eUrl = it.edit_url;
        return `
          <tr>
            <td>
              <a class="pkt-qkey" href="${esc(eUrl)}" target="_blank" rel="noopener">${esc(it.qkey)}</a>
              <div style="margin-top:3px;"><span class="badge badge-bom">Lot #${esc(it.lot_number)}</span></div>
            </td>
            <td>
              <strong>${esc(it.job_number)}</strong><br>
              <span style="color:#475569;font-size:12px;">${esc(it.job_site)}</span>
            </td>
            <td>
              <div>${esc(it.category)}</div>
              <div style="color:#64748b;font-size:12px;">${esc(it.sub_category)} ${it.sequence ? `(Seq ${esc(it.sequence)})` : ""}</div>
            </td>
            <td style="white-space:nowrap;font-size:12px;">
              <div><strong>DPM:</strong> ${esc(it.dpm)}</div>
              <div><strong>PS:</strong> ${esc(it.ps)}</div>
            </td>
            <td>
              <div><strong>Linked:</strong> ${esc(it.linked_display || "—")}</div>
              <div style="margin-top:3px;"><span class="badge badge-bom">No BOM Email (${esc(it.elapsed_display || "")})</span></div>
            </td>
            <td style="white-space:nowrap;">
              ${!state.staticMode ? `<button type="button" class="btn btn-xs btn-outline" data-tbl-mark-job="${esc(it.job_number)}" data-tbl-mark-lot="${esc(it.lot_number)}">&#x2713; Mark Sent</button> ` : ""}
              <a class="btn btn-xs btn-primary" href="${esc(eUrl)}" target="_blank" rel="noopener">Scoville &nearr;</a>
            </td>
          </tr>
        `;
      })
      .join("");

    tbody.querySelectorAll("[data-tbl-mark-job]").forEach((b) =>
      b.addEventListener("click", () =>
        markBomSent(b.getAttribute("data-tbl-mark-job"), b.getAttribute("data-tbl-mark-lot"))
      )
    );
    return;
  }

  if (f.milestone === "zero_value") {
    theadRow.innerHTML =
      `<th>QKEY / Status</th>` +
      `<th>Job # &amp; Site</th>` +
      `<th>Category / Sub Category</th>` +
      `<th>DPM / PS</th>` +
      `<th>Available Scope Items &amp; Values</th>` +
      `<th>Assign Value</th>`;

    const filteredZero = (state.evaluation.items || []).filter((it) => itemMatchesFilters(it, f, state.activeSubview));
    if (filteredZero.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:28px;color:#64748b;">No $0 items with available scope values match your filters.</td></tr>`;
      return;
    }

    tbody.innerHTML = filteredZero
      .map((it) => {
        const fUrl = it.forecast_url || it.edit_url;
        const samples = (it.sample_scope_options || []).slice(0, 3).map(esc).join(" &bull; ");
        return `
          <tr>
            <td>
              <a class="pkt-qkey" href="${esc(fUrl)}" target="_blank" rel="noopener">${esc(it.qkey)}</a>
              <div style="margin-top:3px;"><span class="badge ${it.released ? "badge-soon" : "badge-sched"}">${esc(it.release_status || "Unreleased")}</span></div>
            </td>
            <td>
              <strong>${esc(it.job_number)}</strong><br>
              <span style="color:#475569;font-size:12px;">${esc(it.job_site)}</span>
            </td>
            <td>
              <div>${esc(it.category)}</div>
              <div style="color:#64748b;font-size:12px;">${esc(it.sub_category)} ${it.sequence ? `(Seq ${esc(it.sequence)})` : ""}</div>
            </td>
            <td style="white-space:nowrap;font-size:12px;">
              <div><strong>DPM:</strong> ${esc(it.dpm)}</div>
              <div><strong>PS:</strong> ${esc(it.ps)}</div>
            </td>
            <td>
              <span class="badge badge-zero">Value: $0 &middot; ${it.available_scope_count} scope item${it.available_scope_count === 1 ? "" : "s"} available</span>
              ${samples ? `<div style="font-size:11.5px;color:#475569;margin-top:4px;">${samples}${it.available_scope_count > 3 ? ` (+${it.available_scope_count - 3} more)` : ""}</div>` : ""}
            </td>
            <td>
              <a class="btn btn-xs btn-primary" href="${esc(fUrl)}" target="_blank" rel="noopener">Assign Value &nearr;</a>
            </td>
          </tr>
        `;
      })
      .join("");
    return;
  }

  // Strictly isolate columns when a single milestone chip is selected!
  const visibleMilestones = f.milestone
    ? state.milestones.filter((m) => m.key === f.milestone)
    : state.milestones;

  theadRow.innerHTML =
    `<th>QKEY</th>` +
    `<th>Job # &amp; Site</th>` +
    `<th>Category / Sub Category</th>` +
    `<th>DPM / PS</th>` +
    visibleMilestones
      .map((m) => {
        const rt = m.notify_ps ? "DPM + PS" : "DPM";
        return `<th>${esc(m.short)}<br><small>${rt}</small></th>`;
      })
      .join("") +
    `<th>Scoville</th>`;

  const colSpan = 5 + visibleMilestones.length;

  let sourceList = state.evaluation.items;
  if (state.activeSubview === "overdue-table") {
    sourceList = state.evaluation.overdue_items;
  } else if (state.activeSubview === "due-soon-table") {
    sourceList =
      state.evaluation.due_soon_items ||
      (state.evaluation.items || []).filter((x) => x.is_due_soon);
  }

  const filtered = (sourceList || []).filter((it) => itemMatchesFilters(it, f, state.activeSubview));

  if (state.activeSubview === "due-soon-table") {
    const sumEl = document.getElementById("dueSoonToolbarSummary");
    if (sumEl) {
      const d = state.dueSoonDays || 7;
      sumEl.textContent = `Showing ${filtered.length} item${filtered.length === 1 ? "" : "s"} due within the next ${d} day${d === 1 ? "" : "s"} (from ${state.evaluation.as_of_display})`;
    }
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colSpan}" style="text-align:center;padding:28px;color:#64748b;">No items match the current view and filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .slice(0, 300)
    .map((it) => {
      const m = it.milestones || {};
      const msCells = visibleMilestones
        .map((vm) => `<td>${renderMilestoneBadge(m[vm.key])}</td>`)
        .join("");

      return `
        <tr>
          <td>
            <a class="pkt-qkey" href="${esc(it.edit_url)}" target="_blank" rel="noopener">${esc(it.qkey)}</a>
            ${it.on_hold ? `<br><span class="badge badge-soon">On Hold</span>` : ""}
          </td>
          <td>
            <strong>${esc(it.job_number)}</strong><br>
            <span style="color:#475569;font-size:12px;">${esc(it.job_site)}</span>
          </td>
          <td>
            <div>${esc(it.category)}</div>
            <div style="color:#64748b;font-size:12px;">${esc(it.sub_category)} ${it.sequence ? `(Seq ${esc(it.sequence)})` : ""}</div>
          </td>
          <td style="white-space:nowrap;font-size:12px;">
            <div><strong>DPM:</strong> ${esc(it.dpm)}</div>
            <div><strong>PS:</strong> ${esc(it.ps)}</div>
          </td>
          ${msCells}
          <td>
            <a class="btn btn-xs btn-outline" href="${esc(it.edit_url)}" target="_blank" rel="noopener">Edit Dates &nearr;</a>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderDirectory() {
  const tbody = document.getElementById("directoryTableBody");
  if (!state.directory.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;">No team members synced yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = state.directory
    .map((d, idx) => {
      const roles = [];
      if (d.is_dpm) roles.push(`<span class="role-tag">DPM</span>`);
      if (d.is_ps) roles.push(`<span class="role-tag ps">PS</span>`);

      let ruleDesc = "All 6 Tracked Dates";
      if (d.is_ps && !d.is_dpm) ruleDesc = "Field Measurements & PS Request Overdues Only";
      else if (d.is_dpm && d.is_ps) ruleDesc = "All 6 Dates (as DPM) + Field Measurements & PS Request (as PS)";

      return `
        <tr data-dir-idx="${idx}">
          <td><strong>${esc(d.name)}</strong></td>
          <td>${roles.join(" ") || "—"}</td>
          <td style="font-size:12px;color:#475569;">${ruleDesc}</td>
          <td>
            <input type="email" class="dir-email-input" value="${esc(d.email)}" style="width:280px;" />
          </td>
          <td>
            <label class="chk-label">
              <input type="checkbox" class="dir-active-input" ${d.active ? "checked" : ""} />
              <span>Enabled</span>
            </label>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderLogs() {
  const tbody = document.getElementById("logsTableBody");
  if (!state.logs.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;color:#64748b;">No emails sent or previewed yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = state.logs
    .map((l) => {
      let statusCls = "badge-sched";
      if (l.status === "sent") statusCls = "badge-ok";
      else if (l.status === "draft_saved") statusCls = "badge-soon";
      else if (l.status === "error") statusCls = "badge-overdue";

      return `
        <tr>
          <td style="white-space:nowrap;font-size:12px;">${esc(l.created_at.replace("T", " "))}</td>
          <td><strong>${esc(l.recipient_label)}</strong></td>
          <td>${esc(l.to_emails)}</td>
          <td>${esc(l.from_email)}</td>
          <td>${esc(l.subject)}</td>
          <td style="font-size:12px;">${l.item_count} (${esc((l.qkeys || []).slice(0, 5).join(", "))}${(l.qkeys || []).length > 5 ? "..." : ""})</td>
          <td>
            <span class="badge ${statusCls}">${esc(l.status)} (${esc(l.delivery_mode)})</span>
            ${l.error_message ? `<div style="color:#dc2626;font-size:11px;margin-top:3px;">${esc(l.error_message)}</div>` : ""}
          </td>
          <td style="white-space:nowrap;">
            <button class="btn btn-xs btn-outline" data-view-log="${l.id}">View HTML</button>
            <button class="btn btn-xs btn-ghost" data-del-log="${l.id}" title="Delete this log entry">&#x2715;</button>
          </td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("[data-view-log]").forEach((btn) => {
    btn.addEventListener("click", () => viewLogHtml(btn.getAttribute("data-view-log")));
  });
  tbody.querySelectorAll("[data-del-log]").forEach((btn) => {
    btn.addEventListener("click", () => deleteSingleLog(btn.getAttribute("data-del-log")));
  });
}

async function deleteSingleLog(logId) {
  try {
    const res = await apiFetch(`/api/logs/${logId}`, { method: "DELETE" });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed deleting log");
    state.logs = data.logs || [];
    renderLogs();
    document.getElementById("tabLogsCount").textContent = state.logs.length;
  } catch (err) {
    toast(err.message, "err");
  }
}

async function clearLogs(scope) {
  const msg =
    scope === "errors"
      ? "Clear all failed / error log entries?"
      : "Clear ALL email history logs?";
  if (!confirm(msg)) return;
  try {
    const res = await apiFetch(`/api/logs?scope=${encodeURIComponent(scope)}`, { method: "DELETE" });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed clearing logs");
    state.logs = data.logs || [];
    renderLogs();
    document.getElementById("tabLogsCount").textContent = state.logs.length;
    toast(`Cleared ${data.deleted} log entr${data.deleted === 1 ? "y" : "ies"}.`, "ok");
  } catch (err) {
    toast(err.message, "err");
  }
}

function populateSettingsForm() {
  const s = state.settings;
  if (!s) return;
  document.getElementById("setFromEmail").value = s.from_email || "";
  document.getElementById("setFromName").value = s.from_name || "Scoville Detailing Alerts";
  document.getElementById("setEmailSubject").value = s.email_subject || "Overdues on Scoville";
  document.getElementById("setDefaultEmail").value = s.default_recipient_email || "akanday@qiworks.com";
  document.getElementById("setCcEmails").value = s.cc_emails || "";
  document.getElementById("setGroupingMode").value = s.grouping_mode || "digest";
  document.getElementById("setDeliveryMode").value = s.delivery_mode || "outlook_send";
  document.getElementById("setOutlookBehalf").checked = Boolean(s.outlook_send_on_behalf ?? false);

  document.getElementById("setSmtpHost").value = s.smtp_host || "smtp.office365.com";
  document.getElementById("setSmtpPort").value = s.smtp_port || 587;
  document.getElementById("setSmtpTls").checked = Boolean(s.smtp_use_tls ?? true);
  document.getElementById("setSmtpSsl").checked = Boolean(s.smtp_use_ssl ?? false);
  document.getElementById("setSmtpUser").value = s.smtp_username || "";
  document.getElementById("setSmtpPass").value = s.smtp_password || "";

  document.getElementById("setScheduleEnabled").checked = Boolean(s.schedule_enabled);
  document.getElementById("setScheduleTime").value = s.schedule_time || "08:00";
  document.getElementById("setWeekdaysOnly").checked = Boolean(s.schedule_weekdays_only ?? true);
  document.getElementById("lastAutoRunHint").textContent = s.last_auto_run_date
    ? `Last automatic daily run: ${s.last_auto_run_date}`
    : "Last automatic daily run: Never";

  document.getElementById("setScovilleUrl").value = s.scoville_url || "http://scoville:7555";
  document.getElementById("setScovilleEmail").value = s.scoville_email || "";
  document.getElementById("setScovillePassword").value = s.scoville_password || "";

  toggleDeliveryBoxes();
}

function toggleDeliveryBoxes() {
  const mode = document.getElementById("setDeliveryMode").value;
  document.getElementById("smtpOptionsBox").style.display = mode === "smtp" ? "block" : "none";
  document.getElementById("outlookOptionsBox").style.display = mode.startsWith("outlook") ? "flex" : "none";
}

async function openPreviewModal(packetId) {
  if (state.staticMode && window.ScovilleStandalone) {
    const pkt = (state.evaluation?.packets || []).find((p) => p.packet_id === packetId);
    if (!pkt) return toast("Packet not found.", "err");
    const subj = packetSubject(pkt);
    const htmlBody = window.ScovilleStandalone.renderPacketEmailHtml(
      pkt,
      state.evaluation.as_of_display
    );
    state.previewPacketId = packetId;
    document.getElementById("modalTitle").textContent = `Preview: ${subj}`;
    document.getElementById("modalMeta").innerHTML =
      `From: <strong>This PC's Local Outlook</strong> &nbsp;|&nbsp; ` +
      `To: <strong>${esc(pkt.to_emails.join(", "))}</strong> &nbsp;|&nbsp; ` +
      `Assigned: <strong>${esc(pkt.recipient_name)}</strong>`;
    document.getElementById("modalBtnDraft").style.display = "none";
    const sendBtn = document.getElementById("modalBtnSend");
    sendBtn.style.display = "inline-flex";
    sendBtn.innerHTML = "&#x2709; Open in My Outlook";
    document.getElementById("previewIframe").srcdoc = htmlBody;
    document.getElementById("previewModal").classList.remove("hidden");
    return;
  }

  try {
    const res = await apiFetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packet_id: packetId, ...currentEvalParams() }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Could not render preview");

    state.previewPacketId = packetId;
    document.getElementById("modalTitle").textContent = `Preview: ${data.subject}`;
    document.getElementById("modalMeta").innerHTML =
      `From: <strong>${esc(data.from_email)}</strong> &nbsp;|&nbsp; ` +
      `To: <strong>${esc(data.to_emails.join(", "))}</strong> &nbsp;|&nbsp; ` +
      `Assigned: <strong>${esc(data.recipient_name)}</strong>`;

    document.getElementById("modalBtnSend").innerHTML = "&#x2709; Send This Email";
    document.getElementById("modalBtnSend").style.display = "inline-flex";
    document.getElementById("modalBtnDraft").style.display = "inline-flex";

    const iframe = document.getElementById("previewIframe");
    iframe.srcdoc = data.html_body;
    document.getElementById("previewModal").classList.remove("hidden");
  } catch (err) {
    toast(err.message, "err");
  }
}

async function viewLogHtml(logId) {
  try {
    const res = await apiFetch(`/api/logs/${logId}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Could not load log");

    state.previewPacketId = null;
    const l = data.log;
    document.getElementById("modalTitle").textContent = `Logged Email #${l.id}: ${l.subject}`;
    document.getElementById("modalMeta").innerHTML =
      `Sent/Logged: <strong>${esc(l.created_at)}</strong> &nbsp;|&nbsp; ` +
      `From: <strong>${esc(l.from_email)}</strong> &nbsp;|&nbsp; ` +
      `To: <strong>${esc(l.to_emails)}</strong>`;

    document.getElementById("modalBtnSend").style.display = "none";
    document.getElementById("modalBtnDraft").style.display = "none";

    document.getElementById("previewIframe").srcdoc = l.html_body;
    document.getElementById("previewModal").classList.remove("hidden");
  } catch (err) {
    toast(err.message, "err");
  }
}

async function sendPackets(packetIds, overrideMode = null) {
  if (state.staticMode) {
    const allPkts = state.evaluation?.packets || [];
    const targets =
      packetIds === "all"
        ? allPkts
        : allPkts.filter((p) => (packetIds || []).includes(p.packet_id));
    targets.forEach((p, idx) => {
      setTimeout(() => downloadEml(p.packet_id), idx * 250);
    });
    return;
  }

  try {
    const res = await apiFetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        packet_ids: packetIds,
        override_mode: overrideMode,
        ...currentEvalParams(),
      }),
    });
    const data = await res.json();
    if (data.logs) {
      state.logs = data.logs;
      renderLogs();
      document.getElementById("tabLogsCount").textContent = state.logs.length;
    }

    if (!data.ok) {
      const firstErr = (data.results || []).find((r) => r.error)?.error || data.error || "Failed sending email";
      toast(firstErr, "err");
      return;
    }

    const actionWord =
      data.delivery_mode === "outlook_draft"
        ? "Saved to Outlook Drafts"
        : data.delivery_mode === "dry_run"
        ? "Logged in Dry-Run mode"
        : "Sent";
    toast(`${actionWord}: ${data.sent_count} email packet(s)!`, "ok");
    document.getElementById("previewModal").classList.add("hidden");
  } catch (err) {
    toast(err.message, "err");
  }
}

async function saveDirectory() {
  const rows = document.querySelectorAll("#directoryTableBody tr[data-dir-idx]");
  const updated = [];
  rows.forEach((tr) => {
    const idx = Number(tr.getAttribute("data-dir-idx"));
    const orig = state.directory[idx];
    if (!orig) return;
    updated.push({
      ...orig,
      email: tr.querySelector(".dir-email-input").value.trim(),
      active: tr.querySelector(".dir-active-input").checked,
    });
  });

  if (state.staticMode) {
    state.directory = updated;
    try {
      localStorage.setItem("scoville_dir_override", JSON.stringify(updated));
    } catch (_) {}
    toast("Team directory saved in this browser!", "ok");
    await loadState(true);
    return;
  }

  try {
    const res = await apiFetch("/api/directory", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: updated }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed saving directory");
    toast("Team email directory saved!", "ok");
    await loadState(true);
  } catch (err) {
    toast(err.message, "err");
  }
}

function friendlyFetchError(err) {
  const msg = String(err?.message || err || "");
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    if (IS_GITHUB_PAGES) {
      return "Local PC Helper (127.0.0.1:5055) is not running or blocked by HTTPS. Extract the .zip, double-click Setup-This-PC.bat, and open http://127.0.0.1:5055 directly!";
    }
    return "Local helper service stopped responding on 127.0.0.1:5055. Double-click your 'Scoville Overdue Alerts' Desktop shortcut (or Setup-This-PC.bat) and try again.";
  }
  return msg || "Unexpected error";
}

async function saveSettings() {
  const wasMissingCreds = Boolean(state.needsCredentials);
  const payload = {
    from_email: document.getElementById("setFromEmail").value.trim(),
    from_name: document.getElementById("setFromName").value.trim(),
    email_subject: document.getElementById("setEmailSubject").value.trim(),
    default_recipient_email: document.getElementById("setDefaultEmail").value.trim(),
    cc_emails: document.getElementById("setCcEmails").value.trim(),
    grouping_mode: document.getElementById("setGroupingMode").value,
    delivery_mode: document.getElementById("setDeliveryMode").value,
    outlook_send_on_behalf: document.getElementById("setOutlookBehalf").checked,
    smtp_host: document.getElementById("setSmtpHost").value.trim(),
    smtp_port: Number(document.getElementById("setSmtpPort").value || 587),
    smtp_use_tls: document.getElementById("setSmtpTls").checked,
    smtp_use_ssl: document.getElementById("setSmtpSsl").checked,
    smtp_username: document.getElementById("setSmtpUser").value.trim(),
    smtp_password: document.getElementById("setSmtpPass").value,
    schedule_enabled: document.getElementById("setScheduleEnabled").checked,
    schedule_time: document.getElementById("setScheduleTime").value || "08:00",
    schedule_weekdays_only: document.getElementById("setWeekdaysOnly").checked,
    scoville_url: document.getElementById("setScovilleUrl").value.trim(),
    scoville_email: document.getElementById("setScovilleEmail").value.trim(),
    scoville_password: document.getElementById("setScovillePassword").value,
  };

  const btn = document.getElementById("btnSaveSettings");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving...";
  }

  try {
    const res = await apiFetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Could not save settings");
    state.staticMode = false;
    toast("Settings saved!", "ok");
    await loadState(true);
    if (wasMissingCreds && payload.scoville_email && payload.scoville_password) {
      document.querySelector('.tab-btn[data-tab="dashboard"]')?.click();
      await triggerScovilleSync();
    }
  } catch (err) {
    toast(friendlyFetchError(err), "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Save All Settings";
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // Tabs
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.getAttribute("data-tab");
      state.activeTab = tab;
      document.getElementById(`tab-${tab}`).classList.add("active");
    });
  });

  // Subviews & Clickable KPI Cards
  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setActiveSubview(btn.getAttribute("data-subview"));
    });
  });

  document.querySelectorAll(".kpi-card[data-kpi-subview]").forEach((card) => {
    card.addEventListener("click", () => {
      const targetView = card.getAttribute("data-kpi-subview");
      setActiveSubview(targetView);
    });
  });

  // Due Soon Lookahead Window Controls (Default = 7 Days, plus Custom option)
  const duePresetSel = document.getElementById("dueSoonPresetSelect");
  const dueCustomWrap = document.getElementById("dueSoonCustomWrap");
  const dueCustomInp = document.getElementById("dueSoonCustomInput");
  const btnApplyCustomDue = document.getElementById("btnApplyCustomDueSoon");

  function applyCustomDueDays() {
    const val = Math.max(1, Math.min(365, Math.round(Number(dueCustomInp?.value) || 7)));
    if (dueCustomInp) dueCustomInp.value = String(val);
    state.dueSoonDays = val;
    loadState(true);
  }

  duePresetSel?.addEventListener("change", () => {
    const v = duePresetSel.value;
    state.dueSoonPreset = v;
    if (v === "custom") {
      dueCustomWrap?.classList.remove("hidden");
      if (dueCustomInp) {
        dueCustomInp.value = String(state.dueSoonDays || 7);
        dueCustomInp.focus();
        dueCustomInp.select();
      }
    } else {
      dueCustomWrap?.classList.add("hidden");
      const n = Number(v) || 7;
      state.dueSoonDays = n;
      if (dueCustomInp) dueCustomInp.value = String(n);
      loadState(true);
    }
  });

  btnApplyCustomDue?.addEventListener("click", applyCustomDueDays);
  dueCustomInp?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyCustomDueDays();
    }
  });
  dueCustomInp?.addEventListener("change", applyCustomDueDays);

  // Sync & Date Controls
  document.getElementById("btnSyncNow").addEventListener("click", triggerScovilleSync);
  document.getElementById("asOfDateInput").addEventListener("change", () => loadState(true));
  document.getElementById("chkIncludeDueToday").addEventListener("change", () => loadState(true));
  document.getElementById("chkExcludeOnHold").addEventListener("change", () => loadState(true));

  document.getElementById("btnDateToday").addEventListener("click", () => {
    document.getElementById("asOfDateInput").value = state.today;
    loadState(true);
  });
  document.getElementById("btnDateTomorrow").addEventListener("click", () => {
    document.getElementById("asOfDateInput").value = addDaysIso(state.today, 1);
    loadState(true);
  });
  document.getElementById("btnDatePlus7").addEventListener("click", () => {
    document.getElementById("asOfDateInput").value = addDaysIso(state.today, 7);
    loadState(true);
  });

  // Client-side Filters
  ["filterDpm", "filterPs"].forEach((id) =>
    document.getElementById(id).addEventListener("change", () => {
      renderPackets();
      renderItemsTable();
    })
  );
  document.getElementById("filterSearch").addEventListener("input", () => {
    renderPackets();
    renderItemsTable();
  });

  // Bulk Send / Draft
  document.getElementById("btnSendAll").addEventListener("click", () => {
    const cnt = state.evaluation?.packets?.length || 0;
    if (!cnt) return;
    if (confirm(`Send ${cnt} overdue email packet(s) now via ${deliveryLabel(state.settings.delivery_mode)}?`)) {
      sendPackets("all", null);
    }
  });
  document.getElementById("btnDraftAll").addEventListener("click", () => {
    sendPackets("all", "outlook_draft");
  });

  // Directory Actions
  document.getElementById("btnSaveDirectory").addEventListener("click", saveDirectory);
  document.getElementById("btnSetAllDefaultEmail").addEventListener("click", () => {
    const defEmail = state.settings.default_recipient_email || "akanday@qiworks.com";
    document.querySelectorAll(".dir-email-input").forEach((inp) => {
      inp.value = defEmail;
    });
    toast(`Filled all rows with ${defEmail} — click 'Save Directory Changes' to confirm.`);
  });
  document.getElementById("btnAddPerson").addEventListener("click", async () => {
    const name = document.getElementById("newPersonName").value.trim();
    const email = document.getElementById("newPersonEmail").value.trim() || state.settings.default_recipient_email;
    const is_dpm = document.getElementById("newPersonDpm").checked;
    const is_ps = document.getElementById("newPersonPs").checked;
    if (!name) return toast("Enter a Scoville name first.", "err");
    state.directory.push({ name, email, is_dpm, is_ps, active: true });
    renderDirectory();
    await saveDirectory();
    document.getElementById("newPersonName").value = "";
  });

  // Logs & Settings Actions
  document.getElementById("btnRefreshLogs").addEventListener("click", () => loadState(true));
  document.getElementById("btnClearErrorLogs").addEventListener("click", () => clearLogs("errors"));
  document.getElementById("btnClearAllLogs").addEventListener("click", () => clearLogs("all"));
  document.getElementById("setDeliveryMode").addEventListener("change", toggleDeliveryBoxes);
  document.getElementById("btnSaveSettings").addEventListener("click", saveSettings);

  document.getElementById("btnSendSampleTest").addEventListener("click", async () => {
    await saveSettings();
    const to_email = document.getElementById("testEmailTarget").value.trim() || "akanday@qiworks.com";
    const btn = document.getElementById("btnSendSampleTest");
    btn.disabled = true;
    btn.textContent = "Sending...";
    try {
      const res = await apiFetch("/api/send-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to_email }),
      });
      const data = await res.json();
      if (data.logs) {
        state.logs = data.logs;
        renderLogs();
      }
      if (!data.ok) throw new Error(data.error || "Test send failed");
      toast(`Test email (${data.status}) for ${to_email}!`, "ok");
    } catch (err) {
      toast(err.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Send Sample Test";
    }
  });

  // Modal Actions
  document.getElementById("modalBtnClose").addEventListener("click", () => {
    document.getElementById("previewModal").classList.add("hidden");
  });
  document.getElementById("previewModal").addEventListener("click", (e) => {
    if (e.target.id === "previewModal") {
      document.getElementById("previewModal").classList.add("hidden");
    }
  });
  document.getElementById("modalBtnSend").addEventListener("click", () => {
    if (state.previewPacketId) sendPackets([state.previewPacketId], null);
  });
  document.getElementById("modalBtnDraft").addEventListener("click", () => {
    if (state.previewPacketId) sendPackets([state.previewPacketId], "outlook_draft");
  });

  const searchBox = document.getElementById("filterSearch");
  if (searchBox) searchBox.value = "";
  setTimeout(() => {
    if (searchBox && document.activeElement !== searchBox && searchBox.value.includes("@")) {
      searchBox.value = "";
      renderPackets();
      renderItemsTable();
    }
  }, 450);

  loadState(false);
});

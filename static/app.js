const API_BASE =
  window.location.protocol === "https:" || window.location.hostname.endsWith("github.io")
    ? "http://127.0.0.1:5055"
    : "";

function apiFetch(path, opts) {
  return fetch(`${API_BASE}${path}`, opts);
}

const state = {
  today: "",
  syncedAt: null,
  milestones: [],
  evaluation: null,
  directory: [],
  settings: {},
  effectiveSender: "Local Outlook Account",
  logs: [],
  activeTab: "dashboard",
  activeSubview: "packets",
  selectedMilestone: "",
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
  };
}

async function loadState(preserveDate = false) {
  const dot = document.getElementById("syncStatusDot");
  dot.className = "dot syncing";
  try {
    let url = "/api/state";
    if (preserveDate) {
      const p = currentEvalParams();
      const qs = new URLSearchParams({
        as_of: p.as_of,
        include_due_today: String(p.include_due_today),
        exclude_on_hold: String(p.exclude_on_hold),
        milestone: p.milestone,
      });
      url += `?${qs.toString()}`;
    }
    const res = await apiFetch(url);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed to load state");

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
    dot.className = "dot error";
    document.getElementById("lastSyncText").textContent = "Local Scoville service offline";
    document.getElementById("packetsContainer").innerHTML = `
      <div class="empty-state">
        <h3>Local Scoville &amp; Outlook Service Not Running on This PC</h3>
        <p>
          To sync private QIWorks Scoville data (<code>http://scoville:7555</code>) and send from your local Outlook,
          double-click <strong><code>run_silent.vbs</code></strong> (or <strong><code>start.bat</code></strong>) in your <code>Scoville-Overdue-Alerts</code> folder, then click <strong>Retry Connection</strong>.
        </p>
        <div class="inline-row" style="justify-content:center;">
          <button type="button" class="btn btn-primary" onclick="loadState(false)">Retry Connection</button>
          <a class="btn btn-outline" href="http://127.0.0.1:5055/">Open Local URL (127.0.0.1:5055)</a>
        </div>
      </div>
    `;
    toast("Start run_silent.vbs / start.bat on this PC to connect to Scoville.", "err");
  }
}

async function triggerScovilleSync() {
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
    toast(err.message, "err");
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

  if (isZero) {
    document.getElementById("kpiTotalItems").textContent = sum.zero_value_scanned || 0;
    document.getElementById("kpiOnHoldNote").textContent =
      `Scanned $0 items (${sum.zero_value_unreleased_count || 0} unreleased, ${sum.zero_value_released_count || 0} released caught)`;
    document.getElementById("kpiOverdueItems").textContent = sum.overdue_items_count;
    document.getElementById("kpiOverdueMilestones").textContent =
      `$0 items w/ real scope values available (separate from All)`;
    document.getElementById("kpiPacketsCount").textContent = sum.recipients_to_email;
    document.getElementById("kpiDueSoon").textContent = "—";
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
    document.getElementById("kpiDueSoon").textContent = sum.due_soon_3d_count;
  }

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
    <div class="ms-divider" title="$0 Items are tracked separately and excluded from All"></div>
    <div class="ms-chip zero-chip ${state.selectedMilestone === "zero_value" ? "active" : ""}" data-ms="zero_value" title="Separate view: $0 items (released & unreleased) that have real job scope values available to assign (DPM only)">
      <span>$0 Items <small style="color:#6366f1;">(DPM · Separate)</small></span>
      <span class="count ${zeroCnt > 0 ? "zero-hot" : ""}">${zeroCnt}</span>
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

function itemMatchesFilters(it, f) {
  if (f.dpm && it.dpm !== f.dpm) return false;
  if (f.ps && it.ps !== f.ps) return false;
  if (f.milestone === "zero_value") {
    if (!it.is_zero_value_item) return false;
  } else if (f.milestone) {
    const ms = it.milestones?.[f.milestone];
    if (!ms || !ms.is_overdue) return false;
  }
  if (f.search) {
    const hay = `${it.qkey} ${it.job_number} ${it.job_site} ${it.category} ${it.sub_category} ${it.dpm} ${it.ps} ${it.lot_number || ""}`.toLowerCase();
    if (!hay.includes(f.search)) return false;
  }
  return true;
}

function renderPackets() {
  const container = document.getElementById("packetsContainer");
  if (!state.evaluation) return;
  const f = getActiveFilters();

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
    const msLabel = state.selectedMilestone === "zero_value" ? "$0 Value" : (msObj ? msObj.label : "Schedule");
    container.innerHTML = `
      <div class="empty-state">
        <h3>No ${esc(msLabel)} Items Found</h3>
        <p>
          ${
            isToday && !state.selectedMilestone
              ? "Great news — 0 items have missed dates strictly before today in Scoville."
              : "No items match your current selection / filter."
          }
        </p>
        <div class="inline-row" style="justify-content:center;">
          ${state.selectedMilestone ? `<button type="button" class="btn btn-outline" id="emptyBtnShowAll">Back to All Overdues</button>` : ""}
          <button type="button" class="btn btn-outline" id="emptyBtnDueToday">Include Items Due Today</button>
          <button type="button" class="btn btn-primary" id="emptyBtnPlus7">Simulate +7 Days Out</button>
        </div>
      </div>
    `;
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
      const countCls = isZeroPkt ? "badge-zero" : "badge-overdue";

      const itemsHtml = pkt.items
        .map((it) => {
          const itemUrl = isZeroPkt ? (it.forecast_url || it.edit_url) : it.edit_url;
          const badges = (it.relevant_milestones || [])
            .map((m) => {
              if (m.is_zero_value) {
                return `<span class="badge badge-zero" title="${esc((m.sample_scopes || []).join(' | '))}">${esc(m.release_status)} &middot; ${esc(m.display)}</span>`;
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
            <button class="btn btn-xs btn-outline" data-draft="${esc(pkt.packet_id)}">Save Outlook Draft</button>
            <button class="btn btn-xs ${isZeroPkt ? "btn-primary" : "btn-danger"}" data-send="${esc(pkt.packet_id)}">&#x2709; Send Email</button>
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
  container.querySelectorAll("[data-send]").forEach((b) =>
    b.addEventListener("click", () => sendPackets([b.getAttribute("data-send")], null))
  );
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
    return `<span class="badge badge-soon">${esc(m.display)}</span>`;
  }
  return `<span class="badge badge-sched">${esc(m.display)}</span>`;
}

function renderItemsTable() {
  const theadRow = document.getElementById("itemsTableHeadRow");
  const tbody = document.getElementById("itemsTableBody");
  if (!state.evaluation) return;
  const f = getActiveFilters();

  if (f.milestone === "zero_value") {
    theadRow.innerHTML =
      `<th>QKEY / Status</th>` +
      `<th>Job # &amp; Site</th>` +
      `<th>Category / Sub Category</th>` +
      `<th>DPM / PS</th>` +
      `<th>Available Scope Items &amp; Values</th>` +
      `<th>Assign Value</th>`;

    const filteredZero = (state.evaluation.items || []).filter((it) => itemMatchesFilters(it, f));
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

  const sourceList =
    state.activeSubview === "overdue-table"
      ? state.evaluation.overdue_items
      : state.evaluation.items;

  const filtered = (sourceList || []).filter((it) => itemMatchesFilters(it, f));

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

async function saveSettings() {
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

  try {
    const res = await apiFetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Could not save settings");
    toast("Settings saved!", "ok");
    await loadState(true);
  } catch (err) {
    toast(err.message, "err");
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

  // Subviews
  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.activeSubview = btn.getAttribute("data-subview");
      if (state.activeSubview === "packets") {
        document.getElementById("subview-packets").classList.add("active");
        document.getElementById("subview-table").classList.remove("active");
      } else {
        document.getElementById("subview-packets").classList.remove("active");
        document.getElementById("subview-table").classList.add("active");
        renderItemsTable();
      }
    });
  });

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

  loadState(false);
});

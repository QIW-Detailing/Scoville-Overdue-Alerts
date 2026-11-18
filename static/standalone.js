// Standalone browser-side evaluator & Times New Roman .eml composer for GitHub Pages
// Allows any colleague to view the full dashboard, filter milestones/$0 items, preview emails,
// and open ready-to-send emails in their own PC's Microsoft Outlook with ZERO downloads!

(function () {
  const TNR = "font-family:'Times New Roman',Times,serif;";

  function escHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatDisplayDate(iso) {
    if (!iso) return "—";
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
  }

  function daysBetween(refIso, dueIso) {
    const [ry, rm, rd] = refIso.split("-").map(Number);
    const [dy, dm, dd] = dueIso.split("-").map(Number);
    const tRef = Date.UTC(ry, rm - 1, rd);
    const tDue = Date.UTC(dy, dm - 1, dd);
    return Math.round((tRef - tDue) / 86400000);
  }

  function evaluateSnapshot(snapshot, directory, settings, params) {
    const rawItems = snapshot.items || [];
    const zeroValueItems = snapshot.zero_value_items || [];
    const zeroValueScanned = snapshot.zero_value_scanned || 0;
    const milestones = snapshot.milestones || [];

    const now = new Date();
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const refIso = params.as_of || todayIso;
    const refDisplay = formatDisplayDate(refIso);

    const incToday = Boolean(params.include_due_today);
    const excHold = params.exclude_on_hold !== undefined ? Boolean(params.exclude_on_hold) : true;
    const reqFilter = (params.milestone || "").trim();
    const isZeroMode = reqFilter === "zero_value";
    const validKeys = new Set(milestones.map((m) => m.key));
    const msFilter = validKeys.has(reqFilter) ? reqFilter : "";
    const defaultEmail = (settings.default_recipient_email || "akanday@qiworks.com").trim();
    const groupingMode = settings.grouping_mode || "digest";

    const dirByName = {};
    (directory || []).forEach((d) => {
      dirByName[(d.name || "").trim().toLowerCase()] = d;
    });

    function resolvePerson(name) {
      const entry = dirByName[(name || "").trim().toLowerCase()];
      if (entry) return [entry.email || defaultEmail, Boolean(entry.active ?? true)];
      return [defaultEmail, true];
    }

    const activeZeroItems = zeroValueItems.filter((z) => !(excHold && z.on_hold));
    const evaluatedItems = [];
    const overdueItems = [];
    const milestoneCounts = {};
    milestones.forEach((m) => {
      milestoneCounts[m.key] = 0;
    });
    let allOverdueItemsUnfilteredCount = 0;
    let dueSoonCount = 0;

    for (const item of rawItems) {
      if (item.tekla_linked) continue;
      if (excHold && item.on_hold) continue;

      const evalMilestones = {};
      const allItemOverdue = [];
      const filteredItemOverdue = [];
      let itemHasDueSoon = false;

      for (const m of milestones) {
        const mKey = m.key;
        const rawM = (item.milestones && item.milestones[mKey]) || {
          status: "unscheduled",
          date: null,
          display: "Unscheduled",
        };
        const status = rawM.status || "unscheduled";
        const isoDt = rawM.date || null;
        let daysOverdue = null;
        let isOverdue = false;
        let isDueToday = false;
        let isDueSoon = false;

        if (status === "scheduled" && isoDt) {
          const delta = daysBetween(refIso, isoDt);
          daysOverdue = delta;
          isDueToday = delta === 0;
          isOverdue = incToday ? delta >= 0 : delta > 0;
          if (!isOverdue && delta >= -3 && delta <= 0) {
            isDueSoon = true;
          }
        }

        if (isDueSoon && (!msFilter || msFilter === mKey)) {
          itemHasDueSoon = true;
        }

        const enriched = {
          key: mKey,
          label: m.label,
          short: m.short,
          notify_ps: Boolean(m.notify_ps),
          is_field_dims: Boolean(m.notify_ps),
          status,
          date: isoDt,
          display: rawM.display || "—",
          days_overdue: daysOverdue,
          is_overdue: isOverdue,
          is_due_today: isDueToday,
          is_due_soon: isDueSoon,
        };
        evalMilestones[mKey] = enriched;
        if (isOverdue) {
          milestoneCounts[mKey] = (milestoneCounts[mKey] || 0) + 1;
          allItemOverdue.push(enriched);
          if (!isZeroMode && (!msFilter || msFilter === mKey)) {
            filteredItemOverdue.push(enriched);
          }
        }
      }

      if (allItemOverdue.length > 0) allOverdueItemsUnfilteredCount++;
      if (itemHasDueSoon && !isZeroMode) dueSoonCount++;

      const hasPsOverdue = filteredItemOverdue.some((m) => m.notify_ps);
      const [dpmEmail, dpmActive] = resolvePerson(item.dpm);
      const [psEmail, psActive] = resolvePerson(item.ps);

      const notifyRoles = [];
      if (filteredItemOverdue.length > 0) {
        notifyRoles.push({ role: "DPM", name: item.dpm, email: dpmEmail, active: dpmActive });
        if (hasPsOverdue) {
          notifyRoles.push({ role: "PS", name: item.ps, email: psEmail, active: psActive });
        }
      }

      const maxDays = filteredItemOverdue.reduce(
        (acc, m) => Math.max(acc, m.days_overdue || 0),
        0
      );

      const enrichedItem = {
        ...item,
        milestones: evalMilestones,
        overdue_milestones: filteredItemOverdue,
        overdue_count: filteredItemOverdue.length,
        is_overdue: filteredItemOverdue.length > 0,
        has_ps_overdue: hasPsOverdue,
        max_days_overdue: maxDays,
        notify_recipients: notifyRoles,
      };
      evaluatedItems.push(enrichedItem);
      if (enrichedItem.is_overdue) overdueItems.push(enrichedItem);
    }

    const allMilestonesSum = Object.values(milestoneCounts).reduce((a, b) => a + b, 0);

    if (isZeroMode) {
      const zeroEnriched = activeZeroItems.map((z) => {
        const [dpmEmail, dpmActive] = resolvePerson(z.dpm);
        const relTag = z.released ? `Released (${z.lot_number})` : "Unreleased";
        const scopeCnt = z.available_scope_count || 0;
        const zBadge = {
          key: "zero_value",
          label: "$0 Item — Scope Available",
          short: "$0 Value",
          display: `${scopeCnt} scope item${scopeCnt === 1 ? "" : "s"} available`,
          days_overdue: null,
          is_overdue: true,
          is_zero_value: true,
          release_status: relTag,
          sample_scopes: z.sample_scope_options || [],
        };
        return {
          ...z,
          is_zero_value_item: true,
          release_status: relTag,
          overdue_milestones: [zBadge],
          relevant_milestones: [zBadge],
          is_overdue: true,
          notify_recipients: [{ role: "DPM", name: z.dpm, email: dpmEmail, active: dpmActive }],
        };
      });

      const packets = [];
      if (groupingMode === "per_item") {
        for (const zit of zeroEnriched) {
          const [dpmEmail, dpmActive] = resolvePerson(zit.dpm);
          if (!dpmActive || !dpmEmail) continue;
          packets.push({
            packet_id: `zero_item:${zit.qkey}`,
            packet_kind: "zero_value",
            recipient_name: `${zit.dpm} (DPM — $0 Item)`,
            person_name: zit.dpm,
            role: "DPM ($0 Items)",
            to_emails: [dpmEmail],
            item_count: 1,
            milestone_count: 1,
            qkeys: [zit.qkey],
            items: [zit],
          });
        }
      } else {
        const dpmBuckets = {};
        for (const zit of zeroEnriched) {
          const [dpmEmail, dpmActive] = resolvePerson(zit.dpm);
          if (!dpmActive || !dpmEmail) continue;
          const bKey = `zero_dpm:${zit.dpm.trim().toLowerCase()}`;
          if (!dpmBuckets[bKey]) {
            dpmBuckets[bKey] = {
              packet_id: bKey,
              packet_kind: "zero_value",
              person_name: zit.dpm,
              role: "DPM ($0 Items)",
              to_emails: [dpmEmail],
              items: [],
            };
          }
          dpmBuckets[bKey].items.push(zit);
        }
        Object.values(dpmBuckets)
          .sort((a, b) => a.person_name.localeCompare(b.person_name))
          .forEach((b) => {
            packets.push({
              packet_id: b.packet_id,
              packet_kind: "zero_value",
              recipient_name: `${b.person_name} (${b.role})`,
              person_name: b.person_name,
              role: b.role,
              to_emails: b.to_emails,
              item_count: b.items.length,
              milestone_count: b.items.length,
              qkeys: b.items.map((x) => x.qkey),
              items: b.items,
            });
          });
      }

      return {
        as_of_date: refIso,
        as_of_display: refDisplay,
        include_due_today: incToday,
        exclude_on_hold: excHold,
        milestone_filter: "zero_value",
        is_zero_mode: true,
        summary: {
          total_active_items: evaluatedItems.length,
          total_raw_items: rawItems.length,
          on_hold_excluded: excHold ? zeroValueItems.filter((x) => x.on_hold).length : 0,
          overdue_items_count: zeroEnriched.length,
          all_overdue_items_count: allOverdueItemsUnfilteredCount,
          overdue_milestones_total: zeroEnriched.length,
          all_overdue_milestones_total: allMilestonesSum,
          milestone_breakdown: milestoneCounts,
          zero_value_count: activeZeroItems.length,
          zero_value_scanned: zeroValueScanned,
          zero_value_released_count: activeZeroItems.filter((z) => z.released).length,
          zero_value_unreleased_count: activeZeroItems.filter((z) => !z.released).length,
          recipients_to_email: packets.length,
          due_soon_3d_count: 0,
        },
        items: zeroEnriched,
        overdue_items: zeroEnriched,
        packets,
      };
    }

    overdueItems.sort((a, b) => b.max_days_overdue - a.max_days_overdue || Number(a.qkey) - Number(b.qkey));

    const packets = [];
    if (groupingMode === "per_item") {
      for (const it of overdueItems) {
        const toEmails = [];
        const names = [];
        for (const r of it.notify_recipients) {
          if (!r.active) continue;
          names.push(`${r.name} (${r.role})`);
          if (r.email && !toEmails.includes(r.email)) toEmails.push(r.email);
        }
        if (!toEmails.length) continue;
        packets.push({
          packet_id: `item:${it.qkey}`,
          packet_kind: "overdue",
          recipient_name: names.join(", "),
          role: it.has_ps_overdue ? "DPM & PS" : "DPM",
          to_emails: toEmails,
          item_count: 1,
          milestone_count: it.overdue_milestones.length,
          qkeys: [it.qkey],
          items: [{ ...it, relevant_milestones: it.overdue_milestones }],
        });
      }
    } else {
      const buckets = {};
      for (const it of overdueItems) {
        const dpmName = it.dpm;
        const psName = it.ps;
        const [dpmEmail, dpmActive] = resolvePerson(dpmName);
        const [psEmail, psActive] = resolvePerson(psName);
        const samePerson = dpmName.trim().toLowerCase() === psName.trim().toLowerCase();

        if (dpmActive && dpmEmail) {
          const bKey = `dpm:${dpmName.trim().toLowerCase()}`;
          if (!buckets[bKey]) {
            buckets[bKey] = {
              packet_id: bKey,
              packet_kind: "overdue",
              person_name: dpmName,
              role: "DPM",
              to_emails: [dpmEmail],
              items: [],
            };
          }
          if (samePerson && it.has_ps_overdue) buckets[bKey].role = "DPM & PS";
          buckets[bKey].items.push({ ...it, relevant_milestones: it.overdue_milestones });
        }

        if (it.has_ps_overdue && !samePerson && psActive && psEmail) {
          const bKey = `ps:${psName.trim().toLowerCase()}`;
          const psMs = it.overdue_milestones.filter((m) => m.notify_ps);
          const roleLabels = [...new Set(psMs.map((m) => m.label))].sort();
          const roleLabel = roleLabels.length ? `PS (${roleLabels.join(" & ")})` : "PS";
          if (!buckets[bKey]) {
            buckets[bKey] = {
              packet_id: bKey,
              packet_kind: "overdue",
              person_name: psName,
              role: roleLabel,
              to_emails: [psEmail],
              items: [],
            };
          } else {
            for (const lbl of roleLabels) {
              if (!buckets[bKey].role.includes(lbl)) {
                buckets[bKey].role = "PS (Field Measurements & PS Request)";
              }
            }
          }
          buckets[bKey].items.push({ ...it, relevant_milestones: psMs });
        }
      }

      Object.values(buckets)
        .sort((a, b) => {
          const ar = a.role.startsWith("DPM") ? 0 : 1;
          const br = b.role.startsWith("DPM") ? 0 : 1;
          return ar - br || a.person_name.localeCompare(b.person_name);
        })
        .forEach((b) => {
          packets.push({
            packet_id: b.packet_id,
            packet_kind: "overdue",
            recipient_name: `${b.person_name} (${b.role})`,
            person_name: b.person_name,
            role: b.role,
            to_emails: b.to_emails,
            item_count: b.items.length,
            milestone_count: b.items.reduce((acc, x) => acc + x.relevant_milestones.length, 0),
            qkeys: b.items.map((x) => x.qkey),
            items: b.items,
          });
        });
    }

    const activeMsTotal = msFilter ? milestoneCounts[msFilter] || 0 : allMilestonesSum;

    return {
      as_of_date: refIso,
      as_of_display: refDisplay,
      include_due_today: incToday,
      exclude_on_hold: excHold,
      milestone_filter: msFilter,
      is_zero_mode: false,
      summary: {
        total_active_items: evaluatedItems.length,
        total_raw_items: rawItems.length,
        on_hold_excluded: excHold ? rawItems.filter((x) => x.on_hold).length : 0,
        overdue_items_count: overdueItems.length,
        all_overdue_items_count: allOverdueItemsUnfilteredCount,
        overdue_milestones_total: activeMsTotal,
        all_overdue_milestones_total: allMilestonesSum,
        milestone_breakdown: milestoneCounts,
        zero_value_count: activeZeroItems.length,
        zero_value_scanned: zeroValueScanned,
        zero_value_released_count: activeZeroItems.filter((z) => z.released).length,
        zero_value_unreleased_count: activeZeroItems.filter((z) => !z.released).length,
        recipients_to_email: packets.length,
        due_soon_3d_count: dueSoonCount,
      },
      items: evaluatedItems,
      overdue_items: overdueItems,
      packets,
    };
  }

  function groupItemsByJob(items) {
    const groups = new Map();
    for (const it of items) {
      const jNum = (it.job_number || "").trim();
      const jSite = (it.job_site || "").trim();
      const lbl = jNum ? `Job ${jNum}${jSite ? ` — ${jSite}` : ""}` : jSite || "General";
      if (!groups.has(lbl)) groups.set(lbl, []);
      groups.get(lbl).push(it);
    }
    return [...groups.entries()];
  }

  function outlookBtn(href, text, bg) {
    return (
      `<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto;">` +
      `<tr><td bgcolor="${bg}" style="background:${bg};padding:6px 14px;border:1px solid ${bg};text-align:center;${TNR}">` +
      `<a href="${href}" style="${TNR}font-size:11pt;font-weight:bold;color:#ffffff;text-decoration:none;display:inline-block;">${text}</a>` +
      `</td></tr></table>`
    );
  }

  function renderPacketEmailHtml(packet, asOfDisplay) {
    const recipientLabel = packet.recipient_name || "Team";
    const personName = packet.person_name || recipientLabel.split("(")[0].trim() || "Team";
    const items = packet.items || [];

    if (packet.packet_kind === "zero_value") {
      const rows = [];
      for (const [jobTitle, jobItems] of groupItemsByJob(items)) {
        const cntWord = jobItems.length === 1 ? "1 item" : `${jobItems.length} items`;
        rows.push(
          `<tr><td colspan="4" bgcolor="#e2e8f0" style="${TNR}background:#e2e8f0;padding:8px 12px;border:1px solid #cbd5e1;font-size:11.5pt;font-weight:bold;color:#0f172a;">` +
            `${escHtml(jobTitle)} <span style="${TNR}font-size:10.5pt;font-weight:normal;color:#334155;">(${cntWord})</span></td></tr>`
        );
        jobItems.forEach((it, idx) => {
          const bg = idx % 2 === 0 ? "#ffffff" : "#f8fafc";
          const fUrl = escHtml(it.forecast_url || `http://scoville:7555/item/${it.qkey}/forecastValues`);
          const relStatus = it.release_status || (it.released ? "Released" : "Unreleased");
          const scopeCnt = it.available_scope_count || 0;
          const samples = it.sample_scope_options || [];
          const desc = [
            it.category ? `<strong style="${TNR}color:#0f172a;">${escHtml(it.category)}</strong>` : "",
            it.sub_category ? `<span style="${TNR}color:#334155;">${escHtml(it.sub_category)}</span>` : "",
            it.sequence ? `<span style="${TNR}color:#475569;font-size:10pt;">Sequence: ${escHtml(it.sequence)}</span>` : "",
          ].filter(Boolean).join("<br>") || "—";
          const sampleHtml = samples.length
            ? `<div style="${TNR}font-size:10.5pt;color:#475569;margin-top:3px;">Examples: ${samples.slice(0, 3).map(escHtml).join("; ")}${scopeCnt > 3 ? ` (+${scopeCnt - 3} more)` : ""}</div>`
            : "";

          rows.push(
            `<tr bgcolor="${bg}" style="background:${bg};">` +
              `<td width="95" align="center" valign="top" style="${TNR}padding:9px 10px;border:1px solid #cbd5e1;font-size:11.5pt;font-weight:bold;">` +
              `<a href="${fUrl}" style="${TNR}color:#1e3a8a;text-decoration:underline;">${escHtml(it.qkey)}</a>` +
              `<div style="${TNR}font-size:10pt;color:#475569;font-weight:normal;margin-top:2px;">${escHtml(relStatus)}</div></td>` +
              `<td valign="top" style="${TNR}padding:9px 12px;border:1px solid #cbd5e1;font-size:11pt;line-height:1.4;">${desc}</td>` +
              `<td valign="top" style="${TNR}padding:9px 12px;border:1px solid #cbd5e1;font-size:11pt;line-height:1.4;">` +
              `<strong style="${TNR}color:#1e3a8a;">Current Value: $0.00</strong> &mdash; ${scopeCnt} scope item${scopeCnt === 1 ? "" : "s"} available to assign${sampleHtml}</td>` +
              `<td width="122" align="center" valign="middle" style="${TNR}padding:9px 10px;border:1px solid #cbd5e1;">${outlookBtn(fUrl, "Assign Value", "#1e3a8a")}</td></tr>`
          );
        });
      }
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body,table,td,th,p,div,a,span{font-family:'Times New Roman',Times,serif !important;}</style></head>
<body style="margin:0;padding:18px;background-color:#f8fafc;${TNR}color:#0f172a;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:920px;margin:0 auto;background:#ffffff;border:1px solid #94a3b8;border-collapse:collapse;">
<tr><td bgcolor="#1e3a8a" style="background:#1e3a8a;color:#ffffff;padding:14px 20px;${TNR}border-bottom:2px solid #172554;">
<div style="${TNR}font-size:15pt;font-weight:bold;color:#ffffff;">Scoville $0 Items Report &mdash; Assign Scope Values</div>
<div style="${TNR}font-size:11pt;color:#dbeafe;margin-top:3px;">Assigned DPM: <strong>${escHtml(personName)}</strong> &nbsp;&bull;&nbsp; $0 Items: <strong>${items.length}</strong> &nbsp;&bull;&nbsp; Report Date: <strong>${escHtml(asOfDisplay)}</strong></div>
</td></tr>
<tr><td style="padding:16px 20px 12px 20px;${TNR}font-size:12pt;line-height:1.5;color:#0f172a;">
<p style="margin:0 0 8px 0;${TNR}font-size:12pt;">Hi <strong>${escHtml(personName)}</strong>,</p>
<p style="margin:0;${TNR}font-size:12pt;">The following Scoville items are still at <strong>$0.00</strong> even though job-specific Scope Items &amp; Values are available in the dropdown. Please open each item below and assign its value in Scoville.</p>
</td></tr>
<tr><td style="padding:4px 20px 18px 20px;${TNR}">
<table width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;border:1px solid #cbd5e1;${TNR}">
<thead><tr bgcolor="#f1f5f9" style="background:#f1f5f9;">
<th width="95" align="center" style="${TNR}padding:8px 10px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">QKEY / Status</th>
<th align="left" style="${TNR}padding:8px 12px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">Category / Description</th>
<th align="left" style="${TNR}padding:8px 12px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">Available Scope Items</th>
<th width="122" align="center" style="${TNR}padding:8px 10px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">Scoville</th>
</tr></thead><tbody>${rows.join("")}</tbody></table></td></tr></table></body></html>`;
    }

    const isPsOnly = (packet.role || "").startsWith("PS");
    const introText = isPsOnly
      ? `The following Scoville items have past-due Field Measurements or PS Request dates as of ${asOfDisplay}. Please review these items and update the dates in Scoville.`
      : `The following Scoville schedule dates are past due as of ${asOfDisplay}. Please open each item below and update the missed dates (or check off milestones that are already completed).`;

    const rows = [];
    for (const [jobTitle, jobItems] of groupItemsByJob(items)) {
      const cntWord = jobItems.length === 1 ? "1 item" : `${jobItems.length} items`;
      rows.push(
        `<tr><td colspan="5" bgcolor="#e2e8f0" style="${TNR}background:#e2e8f0;padding:8px 12px;border:1px solid #cbd5e1;font-size:11.5pt;font-weight:bold;color:#0f172a;">` +
          `${escHtml(jobTitle)} <span style="${TNR}font-size:10.5pt;font-weight:normal;color:#334155;">(${cntWord})</span></td></tr>`
      );
      jobItems.forEach((it, idx) => {
        const bg = idx % 2 === 0 ? "#ffffff" : "#f8fafc";
        const eUrl = escHtml(it.edit_url || `http://scoville:7555/item/${it.qkey}/edit`);
        const desc = [
          it.category ? `<strong style="${TNR}color:#0f172a;">${escHtml(it.category)}</strong>` : "",
          it.sub_category ? `<span style="${TNR}color:#334155;">${escHtml(it.sub_category)}</span>` : "",
          it.sequence ? `<span style="${TNR}color:#475569;font-size:10pt;">Sequence: ${escHtml(it.sequence)}</span>` : "",
        ].filter(Boolean).join("<br>") || "—";

        const msLines = (it.relevant_milestones || it.overdue_milestones || []).map((m, mi) => {
          const days = m.days_overdue || 0;
          const tag = days === 0 ? "Due Today" : `${days} days overdue`;
          const col = m.is_field_dims ? "#9a3412" : "#991b1b";
          return `<div style="${TNR}${mi > 0 ? "padding-top:5px;" : ""}font-size:11pt;line-height:1.4;color:#0f172a;">&bull; <strong>${escHtml(m.label)}:</strong> ${escHtml(m.display)} <span style="${TNR}color:${col};font-weight:bold;">(${tag})</span></div>`;
        }).join("");

        rows.push(
          `<tr bgcolor="${bg}" style="background:${bg};">` +
            `<td width="72" align="center" valign="top" style="${TNR}padding:9px 10px;border:1px solid #cbd5e1;font-size:11.5pt;font-weight:bold;"><a href="${eUrl}" style="${TNR}color:#1d4ed8;text-decoration:underline;">${escHtml(it.qkey)}</a></td>` +
            `<td valign="top" style="${TNR}padding:9px 12px;border:1px solid #cbd5e1;font-size:11pt;line-height:1.4;">${desc}</td>` +
            `<td width="135" valign="top" style="${TNR}padding:9px 12px;border:1px solid #cbd5e1;font-size:11pt;line-height:1.4;color:#1e293b;"><strong>DPM:</strong> ${escHtml(it.dpm)}<br><strong>PS:</strong> ${escHtml(it.ps)}</td>` +
            `<td valign="top" style="${TNR}padding:9px 12px;border:1px solid #cbd5e1;font-size:11pt;">${msLines}</td>` +
            `<td width="122" align="center" valign="middle" style="${TNR}padding:9px 10px;border:1px solid #cbd5e1;">${outlookBtn(eUrl, "Update Dates", "#991b1b")}</td></tr>`
        );
      });
    }

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body,table,td,th,p,div,a,span{font-family:'Times New Roman',Times,serif !important;}</style></head>
<body style="margin:0;padding:18px;background-color:#f8fafc;${TNR}color:#0f172a;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:920px;margin:0 auto;background:#ffffff;border:1px solid #94a3b8;border-collapse:collapse;">
<tr><td bgcolor="#7f1d1d" style="background:#7f1d1d;color:#ffffff;padding:14px 20px;${TNR}border-bottom:2px solid #450a0a;">
<div style="${TNR}font-size:15pt;font-weight:bold;color:#ffffff;">Scoville Overdue Schedule Report</div>
<div style="${TNR}font-size:11pt;color:#fecaca;margin-top:3px;">Assigned To: <strong>${escHtml(recipientLabel)}</strong> &nbsp;&bull;&nbsp; Overdue Items: <strong>${items.length}</strong> &nbsp;&bull;&nbsp; Report Date: <strong>${escHtml(asOfDisplay)}</strong></div>
</td></tr>
<tr><td style="padding:16px 20px 12px 20px;${TNR}font-size:12pt;line-height:1.5;color:#0f172a;">
<p style="margin:0 0 8px 0;${TNR}font-size:12pt;">Hi <strong>${escHtml(personName)}</strong>,</p>
<p style="margin:0;${TNR}font-size:12pt;">${escHtml(introText)}</p>
</td></tr>
<tr><td style="padding:4px 20px 18px 20px;${TNR}">
<table width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;border:1px solid #cbd5e1;${TNR}">
<thead><tr bgcolor="#f1f5f9" style="background:#f1f5f9;">
<th width="72" align="center" style="${TNR}padding:8px 10px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">QKEY</th>
<th align="left" style="${TNR}padding:8px 12px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">Category / Description</th>
<th width="135" align="left" style="${TNR}padding:8px 12px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">DPM / PS</th>
<th align="left" style="${TNR}padding:8px 12px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">Missed Date(s)</th>
<th width="122" align="center" style="${TNR}padding:8px 10px;border:1px solid #cbd5e1;font-size:10.5pt;font-weight:bold;color:#1e293b;">Scoville</th>
</tr></thead><tbody>${rows.join("")}</tbody></table></td></tr></table></body></html>`;
  }

  function downloadPacketEml(packet, subject, ccRaw, asOfDisplay) {
    const htmlBody = renderPacketEmailHtml(packet, asOfDisplay);
    const headers = [
      "X-Unsent: 1",
      "MIME-Version: 1.0",
      `To: ${(packet.to_emails || []).join(", ")}`,
    ];
    if (ccRaw && ccRaw.trim()) headers.push(`Cc: ${ccRaw.trim()}`);
    headers.push(`Subject: ${subject}`);
    headers.push('Content-Type: text/html; charset="utf-8"');
    headers.push("Content-Transfer-Encoding: 8bit");
    headers.push("");
    headers.push(htmlBody);

    const emlContent = headers.join("\r\n");
    const blob = new Blob([emlContent], { type: "message/rfc822;charset=utf-8" });
    const safeName = String(packet.person_name || "Recipient").replace(/[^A-Za-z0-9_-]+/g, "_");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Scoville_${safeName}.eml`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  window.ScovilleStandalone = {
    evaluateSnapshot,
    renderPacketEmailHtml,
    downloadPacketEml,
  };
})();

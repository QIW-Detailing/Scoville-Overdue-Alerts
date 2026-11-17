# Scoville Overdue Alerts

Web dashboard and automated email alert tool for **QIWorks Detailing** (`http://scoville:7555`).

## Features
- **Live Read-Only Scoville Sync:** Syncs unreleased detailing schedules (`/any_due_date/weeks/500`, `/release_to_shop/all`, `/admin/all`, `/noValue`) and resolves exact dates hidden behind calendar/exclamation icons.
- **Tracked Schedule Dates (`All` & Single-Milestone Views):**
  - **Field Measurements (FM)** — notifies **DPM + PS**
  - **DWG Complete** — notifies **DPM**
  - **Engineer Calcs** — notifies **DPM**
  - **Approval Submittal** — notifies **DPM**
  - **Release to Shop** — notifies **DPM**
  - **PS Request** — notifies **DPM + PS** *(automatically skips items already linked to Tekla)*
  - *(Skips `Approvals` and other `Shop & Shipping` dates, plus optional `Skip "On Hold" items` filter.)*
- **Separate `$0 Items` Scanner:** Scans all released and unreleased `$0` items (`/item/<QKEY>/forecastValues`), ignores items that only have the 3 default placeholder options (`$1` Unbillable, `$2` Unwritten CO, `$3` Unapproved CO), and flags `$0` items where real job scope values are available to assign (**DPM only**, kept separate from `All`).
- **Automatic Local Outlook Delivery:** Automatically detects and sends from whichever Microsoft Outlook desktop account is signed in on the local Windows PC (supports Send Immediately, Save to Drafts, SMTP, and Dry-Run, formatted in organized **Times New Roman** tables grouped by Job).
- **Team Email Directory & Audit Logs:** Maps Scoville first names (`DPM` / `PS`) to `@qiworks.com` emails and keeps a searchable/clearable log of sent and drafted emails.

## Quick Start (Windows)
1. Install Python 3.10+ and dependencies:
   ```powershell
   python -m pip install -r requirements.txt
   ```
2. Double-click **`start.bat`** (or run `python app.py`) to launch **http://127.0.0.1:5055**.
3. On first launch on a new PC, open the **Settings & Daily Schedule** tab, enter your Scoville login (`http://scoville:7555`), click **Save All Settings**, and click **Sync Scoville Now**.

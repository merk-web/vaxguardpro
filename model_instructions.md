# Model Instructions - VaxGuard Suite

This file outlines the rules, architecture, and project structure for any AI model working on the VaxGuard Suite workspace.

## 🏛️ Project Directory Structure

```
VaxGuard Suite/
├── example files/                # User's sample files and the legacy checker
│   ├── Vaccine_Data_2026-05-20.xlsx
│   ├── Vaccine_Data_2026-06-23.xlsx
│   ├── Vaccine_Data_2026-07-06.xlsx
│   └── vacc checker/             # Legacy batch checker tool
├── model_instructions.md         # [THIS FILE] Project structure & model guidelines
├── task_log.md                   # Live task tracking (Done / Todo)
├── user_profile.md               # User psychological profile & character dossier
├── walkthrough.md                # Technical walkthrough and build/run commands
├── user_guide.md                 # Detailed user manual and guide
├── run.bat                       # 1-click execution script (Web app & Python GUI)
├── index.html                    # Unified Web App PWA index HTML
├── app.js                        # Unified Web App PWA core logic
├── styles.css                    # Unified Web App Glassmorphism CSS styling
├── sw.js                         # Offline PWA service worker
├── manifest.json                 # PWA Manifest configuration
├── icon-192.png                  # PWA Icons
├── icon-500.png                  # PWA Icons
├── vaccine_reviewer.py           # Python GUI application (CustomTkinter)
└── vaxguard.db                   # SQLite database for Python GUI persistence
```

## ⚔️ Vaccine Stock Review Rules

The tool validates vaccine stocks based on the following customizable business logic:

1. **Expiry Date Check (`تاريخ الانتهاء`)**:
   - Parse the Arabic string date format, e.g., `"31 الجمعة , ديسمبر, 2027"`.
   - Identify if the vaccine has expired compared to the current date or a user-selected evaluation date.
2. **Dynamic Vial Capacity Match Check (`مطابقة سعة عبوات اللقاحات`)**:
   - Now driven by the **`vaccine_rules`** table (`dosesPerVial` column) — NOT the old `vaccine_capacities` table.
   - If a vaccine's `dosesPerVial > 1`, its remaining stock must be a multiple of that value.
2b. **Doses Column Capacity Check (`مطابقة عدد الجرعات بسعة العبوة`)**:
   - The mapped `doses` column must also be a multiple of `dosesPerVial` from `vaccine_rules`.
3. **Wastage (`الهادر`) & Destroyed (`المعدم`) Boundaries — Unified Rules Engine**:
   - Controlled by per-vaccine `wastageAllowed` and `destroyedAllowed` boolean toggles in the **`vaccine_rules`** table.
   - **Replaces all hardcoded MMR/BCG/Sabin checks.** Default seeds: MMR (both=true), بى سى جى (both=true), سابين (wastage=true, destroyed=false), all others (both=false).
   - The settings UI (`إدارة قواعد التحقق الموحدة للقاحات`) lets users manage all per-vaccine rules in one table.
4. **Zero-Usage Mismatch**:
   - If the number of vaccinated people (`عدد المتطعمين`) is `0`, then Wastage (`الهادر`) and Destroyed (`المعدم`) must be `0` or empty for ALL vaccines.
5. **Monthly Average Stock Limit (Excessive Stock)**:
   - Compares the remaining stock (`المتبقي`) against a threshold (e.g. 1.5x) of the Monthly Average consumption configured in the `monthly_averages` table.
6. **Duplicate Entries Check (`تكرار إدخال البيانات`)**:
   - Checks if multiple entries exist under the same `تاريخ الدخول` (Entry Date). A duplicate is identified when multiple rows share the same Health Office, Vaccine, Batch ID, and Entry Date.

All rules can be toggled in settings, and bypass exceptions can be added for specific office-vaccine combinations.

## 📁 Excel Highlights & Export Rules

Issues must be highlighted in exported Excel files (RTL layout, auto-fit columns) based on their category:
- 🔴 **Soft Red** (`#FFCDD2`): Expired vaccines.
- 🟠 **Soft Orange** (`#FFE0B2`): Capacity size mismatches.
- 🟡 **Soft Yellow** (`#FFF9C4`): Wastage/zero-usage violations.
- 🔵 **Soft Blue** (`#E0F7FA`): Excessive stock limits.
- 🟣 **Soft Magenta/Lavender** (`#E1BEE7`): Duplicate entries.

## 🛠️ Combined Web & Python Specifications

1. **Web App (PWA)**:
   - Use Vanilla CSS for custom Glassmorphism.
   - ExcelJS via CDN for styled excel parsing and writing.
   - Dexie.js for IndexedDB database management **version 6** (tables: `batches`, `monthly_averages`, `stock_history`, `batch_history`, `rules_config`, `exceptions`, `ties`, `transactions_log`, `vaccine_capacities`, `vaccine_packages`, **`vaccine_rules`**).
   - `vaccine_rules` is the unified per-vaccine config store: `{ vaccine (PK), dosesPerVial, wastageAllowed, destroyedAllowed }`.
   - Validation in `runStockValidation()` looks up `vaccineRules[]` first (exact match, then substring), falls back to `vaccineCapacities[]` only when `vaccineRules` is empty.
   - Fully offline-capable (cached in `sw.js`).
2. **Python App**:
   - CustomTkinter dark-themed GUI matching the web app's style.
   - SQLite for persistence (using same schema names and configurations).

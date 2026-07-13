# Technical Walkthrough - VaxGuard Suite Mapped Engine

VaxGuard Suite is a dual-runtime vaccine stock reviewer and batch safety verifier. It provides both a Progressive Web App (PWA) and a native Python GUI application.

---

## 🏛️ System Architecture

### 1. Web client-side PWA
- **Technologies**: HTML5, Vanilla CSS3 (Custom Glassmorphism styling, CSS custom variables), Vanilla JavaScript (ES6+).
- **Core Libraries**:
  - **Dexie.js**: Wraps IndexedDB to provide structured local storage with transactions.
  - **ExcelJS**: Parses local Excel sheets and exports formatted spreadsheets (RTL layout, gridlines enabled, custom cell colors, and custom border highlights).
  - **Chart.js**: Scientific-grade data analysis charts (Bar chart for stock levels and Doughnut chart for issue categorization).
- **Offline Shell**: `sw.js` (Service Worker) caches core assets (`index.html`, `styles.css`, `app.js`, `manifest.json`, `about-me.jpg`, and icons), enabling the application to run fully offline.

### 2. Desktop Python GUI
- **Technologies**: Python 3.10+, CustomTkinter.
- **Core Libraries**:
  - **customtkinter**: Modern dark-themed native GUI controls.
  - **pandas**: Fast data reading and tabular data processing.
  - **openpyxl**: Reads Excel, writes RTL sheets, draws borders, and applies solid cell fills.
  - **sqlite3**: Built-in SQL database for settings, averages, and histories.
  - **PIL (Pillow)**: Generates offline reports as high-definition PNG images.

---

## 💾 Database Schemas

The PWA and Python app share identical schema layouts:

### A. Valid Batches (`batches`)
Used to check if an Excel row contains a verified vaccine batch.
- `batchId` (TEXT PRIMARY KEY): Unique identifier of the batch.
- `type` (TEXT): Vaccine type.
- `manufacturer` (TEXT): Manufacturer name.
- `expiry` (TEXT): Expiry date.
- `notes` (TEXT): Verification notes.

### B. Monthly Averages (`monthly_averages`)
Stores monthly consumption estimates for warning thresholds.
- `office` (TEXT): Health office name.
- `vaccine` (TEXT): Vaccine type.
- `average` (INTEGER): Monthly average consumption in doses.
- PRIMARY KEY (`office`, `vaccine`).

### C. Name Ties (`ties`)
Stores one-time name mappings for matching sheet spelling differences.
- `category` (TEXT): 'office' or 'vaccine'.
- `sourceName` (TEXT): The original spelling from sheets.
- `targetName` (TEXT): The approved system name.
- PRIMARY KEY (`category`, `sourceName`).

### D. Rules Config (`rules_config`)
Allows toggling individual validation rules.
- `ruleKey` (TEXT PRIMARY KEY): Rule key (e.g. `expiry`, `vial_capacity_match`, `duplicate_entries`).
- `enabled` (INTEGER 0/1): Active status.

### E. Exceptions (`exceptions`)
Defines bypass exceptions for specific office-vaccine-rule combinations.
- `office` (TEXT), `vaccine` (TEXT), `ruleKey` (TEXT).
- PRIMARY KEY (`office`, `vaccine`, `ruleKey`).

### F. Transactions Log (`transactions_log`)
Supports Undo/Rollback of bulk imports.
- `id` (INTEGER PRIMARY KEY AUTOINCREMENT).
- `date` (TEXT), `action` (TEXT), `payload` (TEXT).

### G. Vaccine Capacities (`vaccine_capacities`)
Stores the dynamic doses per vial for each vaccine.
- `vaccine` (TEXT PRIMARY KEY), `dosesPerVial` (INTEGER).

### H. Vaccine Packages (`vaccine_packages`)
Stores the dynamic lists of mandated vaccines per children dose level (e.g., zero, 1st, 2nd, etc.).
- `doseLevel` (TEXT PRIMARY KEY), `vaccines` (TEXT).

---

## 🎨 Excel & Image Issue-Specific Color Coding

Exported reports and generated images highlight rows based on the specific issue:
- 🔴 **Soft Red** (`#FFCDD2`): Expired vaccines or missing child doses.
- 🟠 **Soft Orange** (`#FFE0B2`): Vial capacity mismatch.
- 🟡 **Soft Yellow** (`#FFF9C4`): Wastage or zero-usage violations.
- 🔵 **Soft Blue** (`#E0F7FA`): Excessive stock limits.
- 🟣 **Soft Magenta/Lavender** (`#E1BEE7`): Duplicate entries.

---

## ⚙️ Robust Input Parsers (Numerals & Dates)

### 1. Eastern Arabic Numerals Auto-Translation
- Both runtimes translate Hindi/Eastern Arabic numbers (e.g. `١٠`, `٢٠`, `١`) to standard digits (`10`, `20`, `1`) before parsing, preventing data ingestion errors.

### 2. Expiry Date Parser Logic (Arabic Month Names)
Both runtimes parse date strings like `"31 الجمعة , ديسمبر, 2027"`.
- Clean non-alphanumeric separators.
- Identify the Year (4-digit number between 1900 and 2100).
- Identify the Day (1 or 2-digit number between 1 and 31).
- Identify the Month (by matching the Arabic name to its index, e.g. `ديسمبر` -> 12).
- Returns a standard Date object.

---

## 👶 Utilities - Missing Vaccinations Checker
Unlike stock sheets (which are strictly 1-row-per-record), children lists span multiple rows. The first row contains the child's name, serial, and demographics. Subsequent rows omit the name and demographics but list different vaccines received in the `"نوع الطعم"` column for that target dose.
- **Record Accumulation Pattern**: The parser identifies a new child when a non-empty name cell is encountered, saves the accumulated vaccines for the previous child, and begins a new list.
- **Validation**: It matches the child's target dose level against the corresponding mandated package definition from `vaccine_packages`. If any vaccine is missing, it is flagged.
- **Reporting**: Generates styled RTL Excel reports with soft-red highlighting on the missing vaccines column, and offline PNG graphic reports.

---

## 📊 Dynamic Aggregations & Multi-Format Exporters

### 1. Vaccine Stock Totals Summary
Both applications summarize verified stock data into three categories:
- **Totals by Vaccine (All Offices)**: Combines stock parameters for all registered vaccines.
- **Totals by Vaccine for Specific Office**: Dynamically filters summaries for any selected health clinic.
- **Office Totals**: General summation of stocks by clinic.

### 2. High-Tech Exporters
- **Excel (.xlsx)**: Produces styled RTL tables with auto-fit margins.
- **PNG Images**: Renders analytical tables in a dark-theme dashboard graphic, allowing users to save and share reports as image snapshots.
- **Excel Template**: Downloads a blank standard sheet for distribution centers to register stocks properly.

---

## 🚀 Running the Applications

### Using Launcher Bat
Simply run `run.bat` in the root of the project:
```cmd
run.bat
```
It displays a menu:
1. **Option 1**: Starts `python -m http.server 8888` locally and opens `http://localhost:8888` in your browser.
2. **Option 2**: Runs `python vaccine_reviewer.py` to start the desktop GUI.
3. **Option 3**: Backs up the SQLite database locally as a file.

---

## 🌐 Bilingual (English/Arabic) & Theme Switching Framework
VaxGuard Suite now supports full multi-language localization and UI theme switching:
- **Dual-Language Toggle**: Switch between Arabic and English dynamically in settings/sidebar.
- **Dynamic LTR/RTL Layout Mirroring**:
  - **PWA Web App**: Swaps the document `dir` attribute (`rtl` vs `ltr`) and updates element translations dynamically using a custom `data-i18n` DOM translation engine. Uses logical CSS properties (e.g. `margin-inline-start`, `padding-inline-end`) for fluid layout mirroring.
  - **Python Desktop App**: Destroys and recreates the CustomTkinter layout dynamically on language selection, flipping grid coordinates (`column=0` vs `column=1`) and adjusting text anchors (`anchor="e"` vs `anchor="w"`) for LTR/RTL.
- **Obsidian Theme Toggle**: Toggles between Dark Cyberpunk and Light Minimalist modes in the Web PWA.


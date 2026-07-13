# VaxGuard Suite 🛡️
**منظومة متكاملة لفحص مخزون اللقاحات والتطعيمات**

A professional Arabic-first PWA for vaccine stock review, validation, and immunization tracking for health offices.

## 🚀 Live Demo
👉 **[Open VaxGuard Suite](https://YOUR-USERNAME.github.io/YOUR-REPO-NAME/)**

## ✨ Features
- 📊 **فحص مخزون الوحدات** — Upload stock Excel files, validate against configurable rules
- 🔬 **فحص التشغيلات** — Batch/lot verification against registered batches
- 💉 **فحص التطعيمات الفائتة** — Missing vaccinations checker
- 📈 **معدل الاستهلاك الشهري** — Monthly consumption averages & excessive stock detection
- ⚙️ **إدارة قواعد التحقق الموحدة** — Unified per-vaccine rule management (doses/vial, wastage, destroyed)
- 📱 **PWA** — Installable on mobile and desktop, works offline

## 🛠️ Tech Stack
- Vanilla HTML + CSS + JavaScript (no build step required)
- [ExcelJS](https://github.com/exceljs/exceljs) for Excel parsing & export
- [Dexie.js](https://dexie.org/) for IndexedDB
- [Chart.js](https://www.chartjs.org/) for dashboards
- Service Worker for offline PWA

## 📦 Deploy to GitHub Pages
1. Fork or clone this repo
2. Go to **Settings → Pages**
3. Set source to **main branch / root**
4. Your app is live at `https://username.github.io/repo-name/`

> All data is stored locally in the browser's IndexedDB — no server or backend required.

## 📁 Files
| File | Purpose |
|------|---------|
| `index.html` | Main app shell |
| `app.js` | All logic — parsing, validation, DB, UI |
| `styles.css` | Design system |
| `sw.js` | Service Worker for offline/PWA |
| `manifest.json` | PWA manifest |
| `icon-192.png` | App icon |

## 📄 License
For internal health office use. © 2026

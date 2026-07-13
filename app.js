// ==========================================================================
// PWA SERVICE WORKER REGISTRATION
// ==========================================================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('VaxGuard Suite SW registered.', reg))
            .catch(err => console.error('SW registration failed:', err));
    });
}

// ==========================================================================
// DATABASE SETUP (Dexie.js)
// ==========================================================================
const db = new Dexie("VaxGuardProDB");
db.version(7).stores({
    batches: "&batchId, type, manufacturer, expiry",
    monthly_averages: "[office+vaccine], office, vaccine, average",
    stock_history: "++id, date, filename, totalRows, totalIssues, expiredCount, limitCount, details",
    batch_history: "++id, date, filename, total, valid, mismatch, invalid",
    rules_config: "&ruleKey, enabled",
    exceptions: "[office+vaccine+ruleKey], office, vaccine, ruleKey",
    ties: "&sourceName, category, targetName",
    transactions_log: "++id, date, action, payload",
    vaccine_capacities: "&vaccine, dosesPerVial",
    vaccine_packages: "&doseLevel, vaccines",
    vaccine_rules: "&vaccine, dosesPerVial, wastageAllowed, destroyedAllowed"
});

// ==========================================================================
// GLOBAL STATE & SYSTEM CACHE
// ==========================================================================
let validBatches = [];
let monthlyAverages = [];
let nameTies = [];
let exceptionRules = [];
let rulesConfig = {};
let vaccineCapacities = [];
let vaccineRules = [];  // unified per-vaccine rule config

let currentTab = 'dashboard';
let isDark = true;
let isSidebarMinimized = false;
let isMobileMenuOpen = false;

// Stock Reviewer state
let currentStockWorkbook = null;
let currentStockSheet = null;
let stockHeaders = [];
let stockRows = [];
let stockMapping = {};
let stockResults = [];

// Batch Verifier state
let currentBatchWorkbook = null;
let currentBatchSheet = null;
let batchHeaders = [];
let batchRows = [];
let batchMapping = {};
let batchResults = [];

// Consumption Importer state
let consumptionWorkbook = null;
let consumptionSheetData = null;
let consumptionSheetHeaders = [];
let consumptionSheetRows = [];
let pendingUnmatchedTies = [];
let currentTieIndex = 0;

// Charts
let dosesDistChart = null;
let issuesRadarChart = null;
let historyPieChart = null;

// Settings defaults
let settings = {
    refDateType: 'current',
    customRefDate: '',
    excessiveFactor: 1.5,
    language: 'ar',
    theme: 'dark'
};

// Confirm Modal Callback
let confirmActionCallback = null;

// Arabic month mappings for parsing expiry strings
const ARABIC_MONTHS = {
    'يناير': 0, 'فبراير': 1, 'مارس': 2, 'أبريل': 3, 'مايو': 4, 'يونيو': 5, 'يونية': 5,
    'يوليو': 6, 'يولية': 6, 'أغسطس': 7, 'سبتمبر': 8, 'أكتوبر': 9, 'نوفمبر': 10, 'ديسمبر': 11
};

// Standard system lists
const SYSTEM_VACCINES = [
    "فيتامين أ 100.000 وحدة دولية",
    "فيتامين أ 200.000 وحدة دولية",
    "شلل أطفال سولك",
    "الخماسى",
    "MMR",
    "الثلاثى",
    "شلل أطفال سابين",
    "كبدى B",
    "بى سى جى"
];

// Vaccine dose packages (moved to global to avoid temporal dead zone)
let VACCINE_PACKAGES = {
    "صفرية": ["شلل أطفال سابين"],
    "بى سى جى": ["بى سى جى"],
    "الأولى": ["الخماسى", "شلل أطفال سابين", "شلل أطفال سولك"],
    "الثانية": ["الخماسى", "شلل أطفال سابين", "شلل أطفال سولك"],
    "الثالثة": ["الخماسى", "شلل أطفال سابين", "شلل أطفال سولك"],
    "الرابعة": ["شلل أطفال سابين"],
    "الخامسة": ["MMR", "شلل أطفال سابين"],
    "المنشطة": ["MMR", "الثلاثى", "شلل أطفال سابين"],
    "جرعة الميلاد": ["كبدى B"]
};

// ==========================================================================
// APP INITIALIZATION
// ==========================================================================
document.addEventListener('DOMContentLoaded', initializeApp);

async function initializeApp() {
    // Check & Seed Rules Configuration table
    await seedDefaultRules();
    await seedDefaultPackages();
    await seedDefaultVaccineRules();
    await refreshVaccineRulesFromDB();

    // Load database tables into memory cache
    await refreshBatchesFromDB();
    await refreshAveragesFromDB();
    await refreshTiesFromDB();
    await refreshExceptionsFromDB();
    await refreshRulesFromDB();
    await refreshCapacitiesFromDB(); 
    await refreshPackagesFromDB();
    
    // Check for last bulk transaction to show Undo button
    await checkLastTransaction();

    // Load local settings
    const storedSettings = localStorage.getItem('vaxguard_settings');
    if (storedSettings) {
        settings = { ...settings, ...JSON.parse(storedSettings) };
    }
    
    // Apply Settings UI
    applySettingsToUI();
    
    // Sync theme variable
    if (settings.theme === 'light') {
        isDark = false;
        document.documentElement.classList.add('light');
        const icon = document.getElementById('theme-icon');
        if (icon) icon.className = 'fa-solid fa-sun';
    } else {
        isDark = true;
        document.documentElement.classList.remove('light');
        const icon = document.getElementById('theme-icon');
        if (icon) icon.className = 'fa-solid fa-moon';
    }
    
    // Sync language and translate static elements
    applyLanguage();

    // Render Tables
    renderBatchDBTable();
    renderAveragesTable();
    renderNameTiesTable();
    renderHistoryLogList();
    renderRulesControlUI();
    populateExceptionsDropdowns();

    // Set Default Tab
    switchTab('dashboard');
}

async function seedDefaultRules() {
    const rules = [
        { ruleKey: 'expiry', enabled: 1 },
        { ruleKey: 'vial_capacity_match', enabled: 1 },
        { ruleKey: 'wastage_bounds', enabled: 1 },
        { ruleKey: 'zero_usage_mismatch', enabled: 1 },
        { ruleKey: 'excessive_stock', enabled: 1 },
        { ruleKey: 'duplicate_entries', enabled: 1 },
        { ruleKey: 'doses_capacity_match', enabled: 1 }
    ];
    for (let r of rules) {
        const exists = await db.rules_config.get(r.ruleKey);
        if (!exists) await db.rules_config.put(r);
    }

    // Seed default vaccine capacities
    const checkDefault = await db.vaccine_capacities.get('الثلاثى');
    if (!checkDefault || checkDefault.dosesPerVial !== 1) {
        await db.vaccine_capacities.clear();
        const defaults = [
            { vaccine: 'MMR', dosesPerVial: 10 },
            { vaccine: 'الثلاثى', dosesPerVial: 1 },
            { vaccine: 'الخماسى', dosesPerVial: 1 },
            { vaccine: 'بى سى جى', dosesPerVial: 20 },
            { vaccine: 'شلل أطفال سابين', dosesPerVial: 1 },
            { vaccine: 'شلل أطفال سولك', dosesPerVial: 1 },
            { vaccine: 'ثنائى', dosesPerVial: 1 },
            { vaccine: 'فيتامين أ 100.000 وحدة دولية', dosesPerVial: 1 },
            { vaccine: 'كبدى B', dosesPerVial: 1 },
            { vaccine: 'فيتامين أ 200.000 وحدة دولية', dosesPerVial: 1 }
        ];
        await db.vaccine_capacities.bulkPut(defaults);
    }
}

async function refreshBatchesFromDB() {
    validBatches = await db.batches.toArray();
    document.getElementById('dash-stat-batches').textContent = validBatches.length;
    document.getElementById('batch-db-storage-info').textContent = `سجلات التشغيلات: ${validBatches.length} سجل معتمد`;
}

async function refreshAveragesFromDB() {
    monthlyAverages = await db.monthly_averages.toArray();
}

async function refreshTiesFromDB() {
    nameTies = await db.ties.toArray();
}

async function refreshExceptionsFromDB() {
    exceptionRules = await db.exceptions.toArray();
    renderExceptionsTable();
}

async function refreshRulesFromDB() {
    const rules = await db.rules_config.toArray();
    rulesConfig = {};
    rules.forEach(r => {
        rulesConfig[r.ruleKey] = r.enabled === 1;
    });
}

// Check transactions log to toggle undo button
async function checkLastTransaction() {
    const last = await db.transactions_log.orderBy('id').last();
    const btn = document.getElementById('btn-undo-batch');
    if (last) {
        btn.classList.remove('hidden');
    } else {
        btn.classList.add('hidden');
    }
}

// ==========================================================================
// NAVIGATION, SIDEBAR & THEME
// ==========================================================================
function switchTab(tabId) {
    currentTab = tabId;
    
    // Toggle active classes on panels
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.add('hidden');
        panel.classList.remove('active');
    });
    const activePanel = document.getElementById(`tab-${tabId}`);
    activePanel.classList.remove('hidden');
    activePanel.classList.add('active');

    // Toggle active classes on navigation items
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });
    document.getElementById(`nav-${tabId}`).classList.add('active');

    // Update Topbar Title
    const titles = {
        'dashboard': 'لوحة التحكم والتحليل',
        'stock-reviewer': 'مراجعة وفحص مخزون الوحدات والمكاتب',
        'monthly-averages': 'جدول معدلات الاستهلاك الشهري',
        'name-ties': 'روابط مطابقة الأسماء الذكية',
        'batch-verifier': 'التحقق من أرقام التشغيلات',
        'batch-db': 'دليل أرقام التشغيلات الصالحة',
        'history': 'سجل العمليات والتقارير التاريخية',
        'utilities': 'الخدمات والأدوات الإضافية',
        'settings': 'إعدادات الفحص والنظام',
        'user-guide': 'دليل المستخدم المساعد',
        'about': 'حول المطور (About)'
    };
    const titleKeys = {
        'dashboard': 'nav_dashboard',
        'stock-reviewer': 'nav_stock_reviewer',
        'monthly-averages': 'nav_averages',
        'name-ties': 'nav_ties',
        'batch-verifier': 'nav_batch_verifier',
        'batch-db': 'nav_batch_db',
        'history': 'nav_history',
        'utilities': 'nav_utilities',
        'settings': 'nav_settings',
        'user-guide': 'nav_guide',
        'about': 'nav_about'
    };
    const titleKey = titleKeys[tabId];
    if (titleKey) {
        document.getElementById('page-title').textContent = t(titleKey);
        
        // Also update description/subtitle
        const subtitleKeys = {
            'dashboard': 'dashboard_desc',
            'stock-reviewer': 'upload_stock_desc',
            'monthly-averages': 'table_monthly_averages',
            'name-ties': 'search_ties_placeholder',
            'batch-verifier': 'batch_verifier_desc',
            'batch-db': 'add_batch_title',
            'history': 'audit_log_title',
            'utilities': 'missing_checker_title',
            'settings': 'exceptions_desc',
            'user-guide': 'nav_guide',
            'about': 'dev_title'
        };
        const subKey = subtitleKeys[tabId];
        const subEl = document.getElementById('page-subtitle') || document.querySelector('.page-title + p') || document.querySelector('.workspace-title p');
        if (subKey && subEl) {
            subEl.textContent = t(subKey);
        }
    } else {
        document.getElementById('page-title').textContent = titles[tabId] || 'VaxGuard Suite';
    }

    if (isMobileMenuOpen) toggleMobileMenu();

    // Rerender dashboard data
    if (tabId === 'dashboard') {
        renderDashboardData();
    }
    // Re-render settings tables when switching to settings (needed after DB changes)
    if (tabId === 'settings') {
        refreshPackagesFromDB();
        refreshVaccineRulesFromDB();
        refreshCapacitiesFromDB();
    }
}

function toggleSidebarMinimize() {
    isSidebarMinimized = !isSidebarMinimized;
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('minimized', isSidebarMinimized);
    
    const icon = document.getElementById('min-icon');
    icon.className = isSidebarMinimized ? 'fa-solid fa-chevron-left' : 'fa-solid fa-chevron-right';
}

function toggleMobileMenu() {
    isMobileMenuOpen = !isMobileMenuOpen;
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    
    if (isMobileMenuOpen) {
        sidebar.classList.add('mobile-open');
        overlay.classList.remove('hidden');
    } else {
        sidebar.classList.remove('mobile-open');
        overlay.classList.add('hidden');
    }
}

function toggleTheme() {
    isDark = !isDark;
    settings.theme = isDark ? 'dark' : 'light';
    saveSettings();
    
    document.documentElement.classList.toggle('light', !isDark);
    
    const icon = document.getElementById('theme-icon');
    if (icon) icon.className = isDark ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
    
    if (currentTab === 'dashboard') {
        renderDashboardData();
    }
}

// ==========================================================================
// TOASTS, DIALOGS & CONFIRMATIONS (Replaces native alert/confirm)
// ==========================================================================
function showToast(message, isSuccess = true) {
    const toast = document.getElementById('toast');
    const text = document.getElementById('toast-text');
    const icon = document.getElementById('toast-icon');
    
    text.textContent = message;
    toast.className = `toast-popup ${isSuccess ? 'success' : 'error'}`;
    icon.className = isSuccess ? 'fa-solid fa-circle-check' : 'fa-solid fa-circle-xmark';
    
    toast.classList.remove('hidden');
    
    if (window.toastTimeout) clearTimeout(window.toastTimeout);
    window.toastTimeout = setTimeout(() => {
        toast.classList.add('hidden');
    }, 3500);
}

function showConfirmModal(title, message, onConfirm) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    document.getElementById('modal-confirm').classList.remove('hidden');
    confirmActionCallback = onConfirm;
}

function cancelConfirmModal() {
    document.getElementById('modal-confirm').classList.add('hidden');
    confirmActionCallback = null;
}

function executeConfirmModal() {
    if (confirmActionCallback) {
        confirmActionCallback();
    }
    cancelConfirmModal();
}

function showModal(modalId) {
    document.getElementById(modalId).classList.remove('hidden');
}

function hideModal(modalId) {
    document.getElementById(modalId).classList.add('hidden');
}

// ==========================================================================
// NAME TIE TRANSLATOR (Matches variations in imported spreadsheets)
// ==========================================================================
function translateName(category, rawName) {
    if (!rawName) return '';
    const clean = String(rawName).trim();
    
    // Look up in loaded ties
    const match = nameTies.find(t => t.category === category && t.sourceName === clean);
    if (match) {
        return match.targetName;
    }
    return clean;
}

// ==========================================================================
// SETTINGS: RULES & EXCEPTIONS CONFIG
// ==========================================================================
function applySettingsToUI() {
    const radios = document.getElementsByName('ref-date-type');
    radios.forEach(radio => {
        if (radio.value === settings.refDateType) radio.checked = true;
    });

    const customDateInput = document.getElementById('custom-ref-date');
    if (settings.refDateType === 'custom') {
        customDateInput.classList.remove('hidden');
        customDateInput.value = settings.customRefDate;
    } else {
        customDateInput.classList.add('hidden');
    }

    const factorSelect = document.getElementById('excessive-factor');
    factorSelect.value = settings.excessiveFactor;
}

function toggleRefDateInput() {
    const radios = document.getElementsByName('ref-date-type');
    let selectedType = 'current';
    radios.forEach(r => { if (r.checked) selectedType = r.value; });
    
    settings.refDateType = selectedType;
    
    const customDateInput = document.getElementById('custom-ref-date');
    if (selectedType === 'custom') {
        customDateInput.classList.remove('hidden');
        if (!settings.customRefDate) {
            customDateInput.value = new Date().toISOString().split('T')[0];
            settings.customRefDate = customDateInput.value;
        }
    } else {
        customDateInput.classList.add('hidden');
    }
    
    saveSettings();
}

document.getElementById('custom-ref-date').addEventListener('change', (e) => {
    settings.customRefDate = e.target.value;
    saveSettings();
});

document.getElementById('excessive-factor').addEventListener('change', (e) => {
    settings.excessiveFactor = parseFloat(e.target.value);
    saveSettings();
});

function saveSettings() {
    localStorage.setItem('vaxguard_settings', JSON.stringify(settings));
    const msg = settings.language === 'en' ? 'Settings saved successfully' : 'تم حفظ إعدادات النظام بنجاح';
    showToast(msg, true);
}

function getEvaluationDate() {
    if (settings.refDateType === 'custom' && settings.customRefDate) {
        return new Date(settings.customRefDate);
    }
    return new Date();
}

// Render rules toggles on settings page
function renderRulesControlUI() {
    const container = document.getElementById('rules-toggles-container');
    container.innerHTML = '';

    const ruleLabels = {
        'expiry': { title: 'قاعدة تاريخ انتهاء الصلاحية', desc: 'يمنع صرف أي لقاح منتهي الصلاحية' },
        'vial_capacity_match': { title: 'مطابقة سعة عبوات اللقاحات', desc: 'يفرض أن يكون الرصيد المتبقي مضاعفاً لسعة العبوة المحددة لكل طعم' },
        'wastage_bounds': { title: 'حدود الفاقد الهادر والمعدم', desc: 'يمنع تسجيل هادر/معدم للقاحات بخلاف MMR و BCG وسابين' },
        'zero_usage_mismatch': { title: 'مخالفة الصرف الصفري', desc: 'يمنع تسجيل هادر/معدم إذا كان عدد المتطعمين يساوي صفر' },
        'excessive_stock': { title: 'حدود التخزين الزائد', desc: 'تنبيه عند تجاوز الرصيد المتبقي للمتوسط الشهري المعتمد بمقدار المعامل' },
        'duplicate_entries': { title: 'منع تكرار تسجيل البيانات', desc: 'تنبيه عند وجود تكرار إدخال لنفس التشغيلة للوحدة بنفس تاريخ الدخول' },
        'doses_capacity_match': { title: 'مطابقة عدد الجرعات المعطاة بسعة العبوة', desc: 'يفرض أن يكون عدد الجرعات المعطاة (المتطعمين) مضاعفاً لسعة العبوة — لأن العبوة تُفتح كاملةً ولا يُصرف منها جزء' }
    };

    Object.keys(ruleLabels).forEach(key => {
        const isEnabled = rulesConfig[key] !== false;
        container.innerHTML += `
            <div class="switch-item">
                <div class="switch-details">
                    <span class="switch-title">${ruleLabels[key].title}</span>
                    <span class="switch-desc">${ruleLabels[key].desc}</span>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="switch-rule-${key}" ${isEnabled ? 'checked' : ''} onchange="toggleRuleState('${key}', this.checked)">
                    <span class="slider-toggle"></span>
                </label>
            </div>
        `;
    });
}

async function toggleRuleState(ruleKey, isChecked) {
    const val = isChecked ? 1 : 0;
    await db.rules_config.put({ ruleKey, enabled: val });
    await refreshRulesFromDB();
    showToast(`تم ${isChecked ? 'تفعيل' : 'إيقاف'} القاعدة بنجاح`, true);
}

// Exception rule manager
async function populateExceptionsDropdowns() {
    const offices = [...new Set(monthlyAverages.map(a => a.office))].sort();
    const officeSelect = document.getElementById('exception-office');
    officeSelect.innerHTML = offices.map(o => `<option value="${o}">${o}</option>`).join('');

    const vaccines = [...SYSTEM_VACCINES].sort();
    const vaccineSelect = document.getElementById('exception-vaccine');
    vaccineSelect.innerHTML = vaccines.map(v => `<option value="${v}">${v}</option>`).join('');
}

async function addExceptionRule() {
    const office = document.getElementById('exception-office').value;
    const vaccine = document.getElementById('exception-vaccine').value;
    const ruleKey = document.getElementById('exception-rule').value;

    if (!office || !vaccine || !ruleKey) return;

    const exists = await db.exceptions.get([office, vaccine, ruleKey]);
    if (exists) {
        showToast('هذا الاستثناء مسجل بالفعل سابقاً', false);
        return;
    }

    await db.exceptions.put({ office, vaccine, ruleKey });
    await refreshExceptionsFromDB();
    showToast('تم إضافة استثناء القاعدة بنجاح للوحدة', true);
}

function renderExceptionsTable() {
    const tbody = document.getElementById('exceptions-tbody');
    tbody.innerHTML = '';

    const ruleNames = {
        'expiry':                'تاريخ انتهاء الصلاحية',
        'vial_capacity_match':   'مطابقة سعة عبوات الرصيد المتبقي',
        'doses_capacity_match':  'مطابقة عدد الجرعات المعطاة بسعة العبوة',
        'wastage_bounds':        'حدود الهادر والمعدم',
        'zero_usage_mismatch':   'الهادر مع الصرف الصفري',
        'excessive_stock':       'التخزين الزائد',
        'duplicate_entries':     'تكرار إدخال البيانات'
    };

    if (exceptionRules.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-center text-zinc-500 py-6">لا توجد استثناءات مسجلة حالياً</td></tr>`;
        return;
    }

    exceptionRules.forEach(ex => {
        tbody.innerHTML += `
            <tr>
                <td><strong>${ex.office}</strong></td>
                <td><span class="badge badge-success">${ex.vaccine}</span></td>
                <td>${ruleNames[ex.ruleKey] || ex.ruleKey}</td>
                <td>
                    <button onclick="deleteException('${ex.office}', '${ex.vaccine}', '${ex.ruleKey}')" class="btn btn-secondary btn-sm text-rose-400">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </td>
            </tr>
        `;
    });
}

function deleteException(office, vaccine, ruleKey) {
    showConfirmModal(
        'حذف الاستثناء',
        `هل ترغب في إزالة استثناء القاعدة (${ruleKey}) لمكتب ${office}؟`,
        async () => {
            await db.exceptions.delete([office, vaccine, ruleKey]);
            await refreshExceptionsFromDB();
            showToast('تم إزالة استثناء القاعدة بنجاح', true);
        }
    );
}

// ==========================================================================
// ARABIC NUMBERS & DATE PARSER (Robust clinical string date parser)
// ==========================================================================
function getCellValuePrimitive(cell) {
    if (!cell) return '';
    if (cell.master && cell.master !== cell) {
        return '';
    }
    let val = cell.value;
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') {
        if (val.result !== undefined && val.result !== null) {
            return getCellValuePrimitive({ value: val.result });
        }
        if (val.richText) {
            return val.richText.map(t => t.text).join('');
        }
        if (val.text !== undefined && val.text !== null) {
            return getCellValuePrimitive({ value: val.text });
        }
    }
    return val;
}

function cleanArabicNumbers(val) {
    if (val === null || val === undefined) return '';
    let str = String(val).trim();
    return str.replace(/[٠١٢٣٤٥٦٧٨٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}

function parseArabicDate(dateVal) {
    if (!dateVal) return null;
    if (dateVal instanceof Date) return dateVal;
    if (typeof dateVal === 'number') {
        return new Date((dateVal - 25569) * 86400 * 1000);
    }
    
    let dateStr = cleanArabicNumbers(dateVal);
    if (!dateStr) return null;
    
    dateStr = dateStr.replace(/,/g, ' ').replace(/\s+/g, ' ');
    const tokens = dateStr.split(' ');
    let day = null;
    let month = null;
    let year = null;
    
    for (let t of tokens) {
        if (['السبت', 'الأحد', 'الاثنين', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'].includes(t)) {
            continue;
        }
        if (/^\d+$/.test(t)) {
            const num = parseInt(t, 10);
            if (num > 1900 && num < 2100) {
                year = num;
            } else if (num >= 1 && num <= 31) {
                day = num;
            }
        } else {
            for (let arMonth in ARABIC_MONTHS) {
                if (t.includes(arMonth)) {
                    month = ARABIC_MONTHS[arMonth];
                    break;
                }
            }
        }
    }
    
    if (year !== null && month !== null && day !== null) {
        return new Date(year, month, day);
    }
    
    const fallbackParse = Date.parse(dateStr);
    if (!isNaN(fallbackParse)) {
        return new Date(fallbackParse);
    }
    
    return null;
}

function formatDateToArabic(date) {
    if (!date || isNaN(date.getTime())) return '—';
    const day = date.getDate();
    const year = date.getFullYear();
    const months = Object.keys(ARABIC_MONTHS);
    const monthName = months.find(k => ARABIC_MONTHS[k] === date.getMonth()) || 'يناير';
    return `${day} , ${monthName}, ${year}`;
}

// ==========================================================================
// VACCINE STOCK REVIEWER (Rules validation & analysis engine)
// ==========================================================================
function handleStockUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    document.getElementById('stock-filename').textContent = file.name;
    
    const reader = new FileReader();
    reader.onload = async (ev) => {
        try {
            const data = new Uint8Array(ev.target.result);
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(data);
            
            currentStockWorkbook = workbook;
            currentStockSheet = workbook.worksheets[0];
            
            const rows = [];
            // Determine the total number of columns from the sheet's actual used range
            const totalCols = currentStockSheet.columnCount || 100;
            currentStockSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
                // Use explicit column-index loop so rowData[0]=col1, rowData[1]=col2, ...
                // eachCell({includeEmpty:true}) starts at the row's minCellAddress (not col 1)
                // which causes index misalignment when rows have different starting columns.
                const rowData = [];
                for (let c = 1; c <= totalCols; c++) {
                    rowData.push(getCellValuePrimitive(row.getCell(c)));
                }
                rows.push({ rowNum: rowNumber, values: rowData });
            });
            
            if (rows.length < 2) {
                showToast('الملف فارغ أو لا يحتوي على صفوف كافية', false);
                return;
            }

            stockHeaders = rows[0].values;
            stockRows = rows.slice(1);

            document.getElementById('stock-upload-zone').classList.add('hidden');
            document.getElementById('stock-mapping-container').classList.remove('hidden');
            document.getElementById('stock-results-container').classList.add('hidden');

            renderStockPreview();
            renderStockMappingUI();
            
        } catch (err) {
            showToast('خطأ في تحميل ملف الإكسيل.', false);
        }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
}

// ── Reset stock upload — shows upload zone, hides results and mapping ────
function resetStockUpload() {
    // Clear state
    currentStockWorkbook = null;
    currentStockSheet    = null;
    stockHeaders         = [];
    stockRows            = [];

    // Clear rendered content
    const previewTable = document.getElementById('stock-preview-table');
    if (previewTable) previewTable.innerHTML = '';
    const mappingFields = document.getElementById('stock-mapping-fields');
    if (mappingFields) mappingFields.innerHTML = '';
    const resultsBody = document.getElementById('stock-results-tbody');
    if (resultsBody) resultsBody.innerHTML = '';

    // Reset file input so same file can be re-selected
    const fileInput = document.getElementById('stock-file-input');
    if (fileInput) fileInput.value = '';

    // Show upload zone, hide mapping and results
    document.getElementById('stock-upload-zone')?.classList.remove('hidden');
    document.getElementById('stock-mapping-container')?.classList.add('hidden');
    document.getElementById('stock-results-container')?.classList.add('hidden');
}

function renderStockPreview() {
    const table = document.getElementById('stock-preview-table');
    table.innerHTML = '';
    
    let headerRowHTML = '<tr class="preview-header">';
    stockHeaders.forEach(h => { headerRowHTML += `<th>${h || '(فارغ)'}</th>`; });
    headerRowHTML += '</tr>';
    
    let bodyRowsHTML = '';
    stockRows.slice(0, 5).forEach(row => {
        bodyRowsHTML += '<tr>';
        row.values.forEach(cell => { bodyRowsHTML += `<td>${cell !== null ? cell : ''}</td>`; });
        bodyRowsHTML += '</tr>';
    });
    
    table.innerHTML = headerRowHTML + bodyRowsHTML;
}

function renderStockMappingUI() {
    const container = document.getElementById('stock-mapping-fields');
    container.innerHTML = '';

    const systemFields = [
        { key: 'office', label: 'مكتب الصحة (مطلوب)', required: true },
        { key: 'vaccine', label: 'الطعم / اللقاح (مطلوب)', required: true },
        { key: 'remaining', label: 'الرصيد المتبقي (مطلوب)', required: true },
        { key: 'vaccinated', label: 'عدد المتطعمين (مطلوب)', required: true },
        { key: 'doses', label: 'عدد الجرعات (اختياري — لفحص مطابقة سعة العبوة)', required: false },
        { key: 'wastage', label: 'الهادر', required: false },
        { key: 'destroyed', label: 'المعدم', required: false },
        { key: 'batchId', label: 'رقم التشغيلة', required: false },
        { key: 'entryDate', label: 'تاريخ الدخول', required: false },
        { key: 'expiry', label: 'تاريخ انتهاء الصلاحية (مطلوب)', required: true }
    ];

    stockMapping = {};

    systemFields.forEach(field => {
        let bestGuess = '';
        const fKey = field.key;
        
        stockHeaders.forEach(h => {
            const hLow = String(h).toLowerCase();
            if (fKey === 'office' && (hLow.includes('مكتب') || hLow.includes('office') || hLow.includes('جهة'))) bestGuess = h;
            else if (fKey === 'vaccine' && (hLow.includes('طعم') || hLow.includes('لقاح') || hLow.includes('vacc') || hLow.includes('اسم'))) bestGuess = h;
            else if (fKey === 'remaining' && (hLow.includes('متبق') || hLow.includes('رصيد') || hLow.includes('remain') || hLow === 'المتبقي')) bestGuess = h;
            else if (fKey === 'vaccinated' && (hLow.includes('متطعم') || hLow === 'عدد المتطعمين')) bestGuess = h;
            else if (fKey === 'doses' && (hLow === 'عدد الجرعات' || hLow.includes('doses') || (hLow.includes('جرعات') && !hLow.includes('متطعم')))) bestGuess = h;
            else if (fKey === 'wastage' && (hLow.includes('هادر') || hLow.includes('waste'))) bestGuess = h;
            else if (fKey === 'destroyed' && (hLow.includes('معدم') || hLow.includes('destroy'))) bestGuess = h;
            else if (fKey === 'batchId' && (hLow.includes('تشغيل') || hLow.includes('batch') || hLow.includes('lot'))) bestGuess = h;
            else if (fKey === 'entryDate' && (hLow.includes('دخول') || hLow.includes('entry') || hLow.includes('reg_date'))) bestGuess = h;
            else if (fKey === 'expiry' && (hLow.includes('انتهاء') || hLow.includes('صلاحية') || hLow.includes('exp'))) bestGuess = h;
        });

        stockMapping[fKey] = bestGuess;

        container.innerHTML += `
            <div class="mapping-item glass">
                <span class="form-label">${field.label}</span>
                <select id="select-map-stock-${fKey}" class="mapping-select">
                    <option value="">— تجاهل هذا الحقل —</option>
                    ${stockHeaders.map(h => `<option value="${h}" ${h === bestGuess ? 'selected' : ''}>${h}</option>`).join('')}
                </select>
            </div>
        `;
    });
}

async function runStockValidation() {
    // -- Refresh live settings from DB so changes take effect without reload
    await refreshRulesFromDB();
    await refreshCapacitiesFromDB();
    await refreshVaccineRulesFromDB();
    await refreshExceptionsFromDB();
    await refreshAveragesFromDB();
    // Collect dropdown values
    const keys = ['office', 'vaccine', 'remaining', 'vaccinated', 'doses', 'wastage', 'destroyed', 'batchId', 'entryDate', 'expiry'];
    keys.forEach(k => {
        const el = document.getElementById(`select-map-stock-${k}`);
        stockMapping[k] = el ? el.value : '';
    });

    if (!stockMapping.office) return showToast('يرجى تحديد عمود مكتب الصحة', false);
    if (!stockMapping.vaccine) return showToast('يرجى تحديد عمود الطعم / اللقاح', false);
    if (!stockMapping.remaining) return showToast('يرجى تحديد عمود الرصيد المتبقي', false);
    if (!stockMapping.vaccinated) return showToast('يرجى تحديد عمود عدد المتطعمين', false);
    if (!stockMapping.expiry) return showToast('يرجى تحديد عمود تاريخ انتهاء الصلاحية', false);

    const officeColIdx = stockHeaders.indexOf(stockMapping.office);
    const vaccineColIdx = stockHeaders.indexOf(stockMapping.vaccine);
    const remainingColIdx = stockHeaders.indexOf(stockMapping.remaining);
    const vaccinatedColIdx = stockHeaders.indexOf(stockMapping.vaccinated);
    const expiryColIdx = stockHeaders.indexOf(stockMapping.expiry);
    
    const dosesColIdx    = stockMapping.doses     ? stockHeaders.indexOf(stockMapping.doses)     : -1;
    const wastageColIdx  = stockMapping.wastage    ? stockHeaders.indexOf(stockMapping.wastage)    : -1;
    const destroyedColIdx= stockMapping.destroyed  ? stockHeaders.indexOf(stockMapping.destroyed)  : -1;
    const batchColIdx    = stockMapping.batchId    ? stockHeaders.indexOf(stockMapping.batchId)    : -1;
    const entryDateColIdx= stockMapping.entryDate  ? stockHeaders.indexOf(stockMapping.entryDate)  : -1;

    const evaluationDate = getEvaluationDate();
    
    stockResults = [];
    let officesWithIssues = new Set();
    let totalIssues = 0;
    let expiredCount = 0;
    let limitCount = 0;

    let newlyFoundAverages = [];

    // Pre-calculate duplicate entries counts
    const dupCounts = new Map();
    if (rulesConfig['duplicate_entries']) {
        stockRows.forEach(row => {
            const rawOffice = String(row.values[officeColIdx] || '').trim();
            const rawVaccine = String(row.values[vaccineColIdx] || '').trim();
            if (!rawOffice || !rawVaccine) return;
            const office = translateName('office', rawOffice);
            const vaccine = translateName('vaccine', rawVaccine);
            const batchId = batchColIdx !== -1 && row.values[batchColIdx] !== undefined ? String(row.values[batchColIdx]).trim() : '';
            const entryDateRaw = entryDateColIdx !== -1 && row.values[entryDateColIdx] !== undefined ? row.values[entryDateColIdx] : '';
            const entryDate = entryDateRaw ? String(entryDateRaw).trim() : '';
            
            const key = `${office.toLowerCase()}_${vaccine.toLowerCase()}_${batchId.toLowerCase()}_${entryDate.toLowerCase()}`;
            dupCounts.set(key, (dupCounts.get(key) || 0) + 1);
        });
    }

    stockRows.forEach(row => {
        // Read raw sheet names
        const rawOffice = String(row.values[officeColIdx] || '').trim();
        const rawVaccine = String(row.values[vaccineColIdx] || '').trim();
        
        if (!rawOffice || !rawVaccine) return;

        // Apply ties translation connection
        const office = translateName('office', rawOffice);
        const vaccine = translateName('vaccine', rawVaccine);

        const remainingStr = cleanArabicNumbers(row.values[remainingColIdx]);
        const remaining = parseInt(remainingStr !== '' ? remainingStr : '0', 10) || 0;

        const vaccinatedStr = cleanArabicNumbers(row.values[vaccinatedColIdx]);
        const vaccinated = parseInt(vaccinatedStr !== '' ? vaccinatedStr : '0', 10) || 0;

        const expiryRaw = row.values[expiryColIdx];
        
        const wastageStr = wastageColIdx !== -1 && row.values[wastageColIdx] !== undefined ? cleanArabicNumbers(row.values[wastageColIdx]) : '0';
        const wastage = parseInt(wastageStr !== '' ? wastageStr : '0', 10) || 0;

        const destroyedStr = destroyedColIdx !== -1 && row.values[destroyedColIdx] !== undefined ? cleanArabicNumbers(row.values[destroyedColIdx]) : '0';
        const destroyed = parseInt(destroyedStr !== '' ? destroyedStr : '0', 10) || 0;

        const batchId = batchColIdx !== -1 && row.values[batchColIdx] !== undefined ? String(row.values[batchColIdx]).trim() : '';
        const entryDateRaw = entryDateColIdx !== -1 && row.values[entryDateColIdx] !== undefined ? row.values[entryDateColIdx] : '';
        const entryDate = entryDateRaw ? String(entryDateRaw).trim() : '';

        let rowIssues = [];
        let issueTypes = []; // 'expired', 'capacity', 'wastage', 'excessive', 'duplicate'
        let isExpired = false;

        // Check helper: Verify if exception rule exists
        const hasException = (ruleKey) => {
            return exceptionRules.some(ex => ex.office === office && ex.vaccine === vaccine && ex.ruleKey === ruleKey);
        };

        // 1. Expiry Check
        if (rulesConfig['expiry'] && !hasException('expiry')) {
            const expiryDate = parseArabicDate(expiryRaw);
            if (!expiryDate) {
                rowIssues.push('صيغة تاريخ الصلاحية غير مدعومة أو فارغة');
                issueTypes.push('expired');
            } else if (expiryDate < evaluationDate) {
                rowIssues.push(`اللقاح منتهي الصلاحية (${formatDateToArabic(expiryDate)})`);
                isExpired = true;
                expiredCount++;
                issueTypes.push('expired');
            }
        }

        // Helper: find per-vaccine rule (exact match first, then substring)
        const vLow = vaccine.toLowerCase();
        const vRule = vaccineRules.find(r => r.vaccine.toLowerCase() === vLow)
                   || vaccineRules.find(r => vLow.includes(r.vaccine.toLowerCase()) && r.vaccine.length > 3)
                   || vaccineCapacities.find(c => c.vaccine.toLowerCase() === vLow && !vaccineRules.length);  // fallback if no rules yet

        // 2. مطابقة سعة عبوات اللقاحات — remaining must be multiple of dosesPerVial (only when checkRemaining is enabled)
        if (rulesConfig['vial_capacity_match'] && !hasException('vial_capacity_match')) {
            if (vRule && vRule.dosesPerVial > 1 && vRule.checkRemaining === true) {
                if (remaining % vRule.dosesPerVial !== 0) {
                    rowIssues.push(`رصيد طعم ${vaccine} المتبقي (${remaining}) غير متوافق مع سعة العبوة (${vRule.dosesPerVial} جرعة) — يجب أن يكون مضاعفاً صحيحاً`);
                    issueTypes.push('capacity');
                }
            }
        }

        // 2b. مطابقة عدد الجرعات بسعة العبوة — doses column must be multiple of dosesPerVial
        if (rulesConfig['doses_capacity_match'] && !hasException('doses_capacity_match')) {
            if (dosesColIdx !== -1 && vRule && vRule.dosesPerVial > 1 && vRule.checkDoses !== false) {
                const dosesRaw = cleanArabicNumbers(row.values[dosesColIdx]);
                const dosesVal = parseInt(dosesRaw !== '' ? dosesRaw : '0', 10) || 0;
                if (dosesVal > 0 && dosesVal % vRule.dosesPerVial !== 0) {
                    rowIssues.push(`عدد الجرعات لطعم ${vaccine} (${dosesVal}) غير متوافق مع سعة العبوة (${vRule.dosesPerVial} جرعة بالزجاجة) — يُتوقع مضاعف صحيح`);
                    issueTypes.push('capacity');
                }
            }
        }

        // 3. حدود الفاقد الهادر والمعدم — driven by per-vaccine toggles in vaccine_rules
        if (rulesConfig['wastage_bounds'] && !hasException('wastage_bounds')) {
            const wAllowed = vRule ? vRule.wastageAllowed  : false;
            const dAllowed = vRule ? vRule.destroyedAllowed : false;
            if (!dAllowed && destroyed > 0) {
                rowIssues.push(`غير مسموح بوجود كميات معدمة (${destroyed}) في طعم ${vaccine}`);
                issueTypes.push('wastage');
            }
            if (!wAllowed && wastage > 0) {
                rowIssues.push(`غير مسموح بوجود فاقد هادر (${wastage}) في طعم ${vaccine}`);
                issueTypes.push('wastage');
            }
        }


        // 4. Zero usage check
        if (rulesConfig['zero_usage_mismatch'] && !hasException('zero_usage_mismatch')) {
            if (vaccinated === 0 && (wastage > 0 || destroyed > 0)) {
                rowIssues.push(`لا يمكن تسجيل فاقد أو تالف (هادر: ${wastage}، معدم: ${destroyed}) لعدم وجود متطعمين`);
                issueTypes.push('wastage');
            }
        }

        // 5. Excessive stock check
        if (rulesConfig['excessive_stock'] && !hasException('excessive_stock')) {
            const matchAvg = monthlyAverages.find(a => a.office === office && a.vaccine === vaccine);
            if (matchAvg) {
                const limit = matchAvg.average * settings.excessiveFactor;
                if (remaining > limit) {
                    rowIssues.push(`تخزين زائد للمخزون: الرصيد (${remaining}) يتجاوز الحد المسموح به (${Math.round(limit)}) لمتوسط استهلاك ${matchAvg.average}`);
                    limitCount++;
                    issueTypes.push('excessive');
                }
            } else {
                newlyFoundAverages.push({ office, vaccine, average: 0 });
            }
        }

        // 6. Duplicate Entries check (Preventing distribution mistakes)
        if (rulesConfig['duplicate_entries'] && !hasException('duplicate_entries')) {
            const dupKey = `${office.toLowerCase()}_${vaccine.toLowerCase()}_${batchId.toLowerCase()}_${entryDate.toLowerCase()}`;
            if (dupCounts.get(dupKey) > 1) {
                rowIssues.push(`تكرار إدخال البيانات: يوجد سجل مكرر مسبقاً بنفس رقم التشغيلة وتاريخ الدخول للوحدة`);
                issueTypes.push('duplicate');
            }
        }

        const cleanRowObj = {};
        stockHeaders.forEach((h, idx) => {
            cleanRowObj[h] = row.values[idx];
        });

        if (rowIssues.length > 0) {
            officesWithIssues.add(office);
            totalIssues += rowIssues.length;
        }

        stockResults.push({
            rowNum: row.rowNum,
            office,
            vaccine,
            batchId,
            expiryText: expiryRaw,
            expiryDate: parseArabicDate(expiryRaw),
            remaining,
            vaccinated,
            wastage,
            destroyed,
            issues: rowIssues,
            issueTypes: issueTypes,
            isExpired,
            originalRow: cleanRowObj
        });
    });

    if (newlyFoundAverages.length > 0) {
        for (let item of newlyFoundAverages) {
            const exists = await db.monthly_averages.get([item.office, item.vaccine]);
            if (!exists) await db.monthly_averages.put(item);
        }
        await refreshAveragesFromDB();
        renderAveragesTable();
        populateExceptionsDropdowns();
    }

    // Save to Database History
    const historyItem = {
        date: new Date(),
        filename: document.getElementById('stock-filename').textContent,
        totalRows: stockResults.length,
        totalIssues: totalIssues,
        expiredCount: expiredCount,
        limitCount: limitCount,
        details: stockResults.filter(r => r.issues.length > 0).map(r => ({
            office: r.office,
            vaccine: r.vaccine,
            issues: r.issues
        }))
    };
    await db.stock_history.add(historyItem);
    renderHistoryLogList();

    // Render Stats
    document.getElementById('stock-stat-total-issues').textContent = totalIssues;
    document.getElementById('stock-stat-expired-issues').textContent = expiredCount;
    document.getElementById('stock-stat-vial-issues').textContent = stockResults.filter(r => r.issues.some(i => i.includes('عبوات') || i.includes('فاقد') || i.includes('متطعمين'))).length;
    
    document.getElementById('stock-results-summary-text').innerHTML = `
        تم فحص <strong class="text-white">${stockResults.length}</strong> سجل عبر <strong class="text-white">${new Set(stockResults.map(r => r.office)).size}</strong> مكتب صحي.
        تم العثور على <strong class="text-rose-400">${totalIssues}</strong> مخالفات في <strong class="text-rose-400">${officesWithIssues.size}</strong> مكتب مختلف.
    `;

    document.getElementById('stock-mapping-container').classList.add('hidden');
    document.getElementById('stock-results-container').classList.remove('hidden');

    renderStockResultsTable('all');
    calculateStockTotals();
    showToast(`اكتمل الفحص: ${totalIssues} مشكلة مكتشفة`, totalIssues === 0);
    renderDashboardData();
}

function renderStockResultsTable(filter = 'all') {
    const tbody = document.getElementById('stock-results-tbody');
    tbody.innerHTML = '';

    let filtered = stockResults;
    if (filter === 'issue') filtered = stockResults.filter(r => r.issues.length > 0);
    else if (filter === 'clean') filtered = stockResults.filter(r => r.issues.length === 0);

    document.getElementById('btn-filter-stock-all').classList.toggle('active', filter === 'all');
    document.getElementById('btn-filter-stock-issue').classList.toggle('active', filter === 'issue');
    document.getElementById('btn-filter-stock-clean').classList.toggle('active', filter === 'clean');

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center text-zinc-500 py-8">لا توجد سجلات تطابق الفلتر المختار</td></tr>`;
        return;
    }

    filtered.forEach(r => {
        const hasIssues = r.issues.length > 0;
        const rowClass = r.isExpired ? 'row-expired' : (hasIssues ? 'row-has-issues' : '');
        const badgeHTML = r.isExpired 
            ? '<span class="badge badge-danger">منتهي الصلاحية</span>' 
            : (hasIssues ? '<span class="badge badge-warning">تنبيه ومخالفات</span>' : '<span class="badge badge-success">سليم</span>');

        tbody.innerHTML += `
            <tr class="${rowClass}">
                <td class="font-mono text-zinc-400">#${r.rowNum}</td>
                <td><strong>${r.office}</strong></td>
                <td>${r.vaccine}</td>
                <td class="font-mono text-violet-300">${r.batchId || '—'}</td>
                <td class="font-mono">${r.remaining}</td>
                <td>${badgeHTML}</td>
                <td class="text-sm text-right text-rose-300 font-semibold note-cell">
                    ${hasIssues ? r.issues.map(i => `• ${i}`).join('<br>') : '<span class="text-emerald-400">تطابق كامل للمواصفات</span>'}
                </td>
            </tr>
        `;
    });
}

function filterStockTable(filter) {
    renderStockResultsTable(filter);
}

// Export styled Excel based on issue severity colors
async function exportStockExcel(allRows = true) {
    if (stockResults.length === 0) return;

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Vaccines Report');
    worksheet.views = [{ rtl: true, showGridLines: true }];

    const columns = stockHeaders.map(h => ({ header: h, key: h, width: 20 }));
    columns.push({ header: 'حالة الفحص والمراجعة', key: 'status_check', width: 22 });
    columns.push({ header: 'تفاصيل المخالفات والمشاكل المكتشفة', key: 'issues_check', width: 45 });
    worksheet.columns = columns;

    // Header Styling
    worksheet.getRow(1).eachCell((cell) => {
        cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '4F46E5' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    // Fills definitions
    const expiredFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCDD2' } }; // Soft red
    const capacityFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0B2' } }; // Soft orange
    const wastageFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9C4' } }; // Soft yellow
    const excessiveFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E0F7FA' } }; // Soft blue
    const duplicateFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E1BEE7' } }; // Soft magenta/lavender

    const expiredBorder = { bottom: { style: 'thin', color: { argb: 'EF5350' } }, top: { style: 'thin', color: { argb: 'EF5350' } }, left: { style: 'thin', color: { argb: 'EF5350' } }, right: { style: 'thin', color: { argb: 'EF5350' } } };
    const capacityBorder = { bottom: { style: 'thin', color: { argb: 'FFA726' } }, top: { style: 'thin', color: { argb: 'FFA726' } }, left: { style: 'thin', color: { argb: 'FFA726' } }, right: { style: 'thin', color: { argb: 'FFA726' } } };
    const wastageBorder = { bottom: { style: 'thin', color: { argb: 'FBC02D' } }, top: { style: 'thin', color: { argb: 'FBC02D' } }, left: { style: 'thin', color: { argb: 'FBC02D' } }, right: { style: 'thin', color: { argb: 'FBC02D' } } };
    const excessiveBorder = { bottom: { style: 'thin', color: { argb: '26C6DA' } }, top: { style: 'thin', color: { argb: '26C6DA' } }, left: { style: 'thin', color: { argb: '26C6DA' } }, right: { style: 'thin', color: { argb: '26C6DA' } } };
    const duplicateBorder = { bottom: { style: 'thin', color: { argb: 'AB47BC' } }, top: { style: 'thin', color: { argb: 'AB47BC' } }, left: { style: 'thin', color: { argb: 'AB47BC' } }, right: { style: 'thin', color: { argb: 'AB47BC' } } };

    let recordsToExport = allRows ? stockResults : stockResults.filter(r => r.issues.length > 0);

    recordsToExport.forEach(r => {
        const rowData = { ...r.originalRow };
        rowData['status_check'] = r.issues.length > 0 ? 'به مخالفات' : 'سليم مطابق';
        rowData['issues_check'] = r.issues.join(' | ');

        const row = worksheet.addRow(rowData);

        if (r.issues.length > 0) {
            let activeFill = wastageFill;
            let activeBorder = wastageBorder;
            
            // Prioritize colors based on issue nature
            if (r.issueTypes.includes('expired')) {
                activeFill = expiredFill;
                activeBorder = expiredBorder;
            } else if (r.issueTypes.includes('duplicate')) {
                activeFill = duplicateFill;
                activeBorder = duplicateBorder;
            } else if (r.issueTypes.includes('capacity')) {
                activeFill = capacityFill;
                activeBorder = capacityBorder;
            } else if (r.issueTypes.includes('excessive')) {
                activeFill = excessiveFill;
                activeBorder = excessiveBorder;
            } else if (r.issueTypes.includes('wastage')) {
                activeFill = wastageFill;
                activeBorder = wastageBorder;
            }

            row.eachCell((cell) => {
                cell.fill = activeFill;
                cell.border = activeBorder;
            });
        }
    });

    // Auto-fit Columns width correctly
    worksheet.columns.forEach(column => {
        let maxLen = 0;
        column.eachCell({ includeEmpty: true }, cell => {
            const valStr = cell.value ? String(cell.value) : '';
            if (valStr.length > maxLen) maxLen = valStr.length;
        });
        column.width = Math.max(maxLen + 4, 15);
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `VaxGuard_Review_${new Date().toISOString().split('T')[0]}.xlsx`;
    link.click();
    showToast('تم تصدير ملف إكسيل المنسق بنجاح', true);
}

// ==========================================================================
// MONTHLY AVERAGES & UNIFIED OFFICE FORM
// ==========================================================================
function renderAveragesTable() {
    const tbody = document.getElementById('averages-table-tbody');
    tbody.innerHTML = '';

    if (monthlyAverages.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-zinc-500 py-12">لا توجد معدلات استهلاك مسجلة حالياً. سيتم تسجيل المكاتب تلقائياً عند رفع ملف المخزون.</td></tr>`;
        return;
    }

    monthlyAverages.forEach(avg => {
        const limitValue = Math.round(avg.average * settings.excessiveFactor);
        tbody.innerHTML += `
            <tr id="avg-row-${avg.office.replace(/\s+/g, '-')}-${avg.vaccine.replace(/\s+/g, '-')}">
                <td><strong>${avg.office}</strong></td>
                <td><span class="badge badge-success font-medium">${avg.vaccine}</span></td>
                <td class="font-mono">${avg.average}</td>
                <td class="font-mono text-amber-400">${limitValue}</td>
                <td>
                    <div class="flex gap-2">
                        <button onclick="editAverage('${avg.office}')" class="btn btn-secondary btn-sm"><i class="fa-solid fa-pen-to-square"></i></button>
                        <button onclick="deleteAverage('${avg.office}', '${avg.vaccine}')" class="btn btn-secondary btn-sm text-rose-400"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </td>
            </tr>
        `;
    });
}

function filterMonthlyAverages() {
    const term = document.getElementById('avg-search-input').value.trim().toLowerCase();
    
    monthlyAverages.forEach(avg => {
        const rowId = `avg-row-${avg.office.replace(/\s+/g, '-')}-${avg.vaccine.replace(/\s+/g, '-')}`;
        const row = document.getElementById(rowId);
        if (!row) return;

        if (avg.office.toLowerCase().includes(term) || avg.vaccine.toLowerCase().includes(term)) {
            row.classList.remove('hidden');
        } else {
            row.classList.add('hidden');
        }
    });
}

// Unified Office average form (all vaccines on one screen)
function showAddAverageModal() {
    document.getElementById('modal-average-title').textContent = 'إدارة حدود استهلاك المكتب الصحي';
    document.getElementById('form-avg-office').value = '';
    document.getElementById('form-avg-office').disabled = false;
    document.getElementById('form-avg-old-office').value = '';
    
    buildVaccineInputsList();
    showModal('modal-average-edit');
}

function buildVaccineInputsList(officeName = null) {
    const container = document.getElementById('form-avg-vaccines-container');
    container.innerHTML = '';

    // Get current averages if officeName provided
    const officeAverages = officeName ? monthlyAverages.filter(a => a.office === officeName) : [];

    // Unique list of system vaccines + default vaccines
    const vaccines = [...new Set([...SYSTEM_VACCINES, ...monthlyAverages.map(a => a.vaccine)])].sort();

    vaccines.forEach(v => {
        const match = officeAverages.find(a => a.vaccine === v);
        const val = match ? match.average : 0;
        
        container.innerHTML += `
            <div class="vaccine-avg-row">
                <span class="vaccine-avg-label">${v}</span>
                <input type="number" min="0" class="vaccine-avg-input" id="avg-input-vacc-${v.replace(/\s+/g, '_')}" value="${val}">
            </div>
        `;
    });
}

function editAverage(office) {
    document.getElementById('modal-average-title').textContent = `تعديل استهلاك مكتب: ${office}`;
    document.getElementById('form-avg-office').value = office;
    document.getElementById('form-avg-office').disabled = true;
    document.getElementById('form-avg-old-office').value = office;

    buildVaccineInputsList(office);
    showModal('modal-average-edit');
}

async function saveAverageFromForm() {
    const office = document.getElementById('form-avg-office').value.trim();
    if (!office) {
        showToast('يرجى كتابة اسم مكتب الصحة', false);
        return;
    }

    const oldOffice = document.getElementById('form-avg-old-office').value;
    const vaccines = [...new Set([...SYSTEM_VACCINES, ...monthlyAverages.map(a => a.vaccine)])].sort();

    // In a transaction
    for (let v of vaccines) {
        const input = document.getElementById(`avg-input-vacc-${v.replace(/\s+/g, '_')}`);
        if (!input) continue;
        const val = parseInt(input.value, 10) || 0;
        
        // Remove old if renamed office
        if (oldOffice && oldOffice !== office) {
            await db.monthly_averages.delete([oldOffice, v]);
        }
        
        // Save averages
        await db.monthly_averages.put({ office, vaccine: v, average: val });
    }

    await refreshAveragesFromDB();
    renderAveragesTable();
    populateExceptionsDropdowns();
    hideModal('modal-average-edit');
    showToast('تم حفظ معدلات استهلاك المكتب بنجاح', true);
}

function deleteAverage(office, vaccine) {
    showConfirmModal(
        'حذف حد الاستهلاك',
        `هل ترغب في حذف حد استهلاك مكتب ${office} لطعم ${vaccine}؟`,
        async () => {
            await db.monthly_averages.delete([office, vaccine]);
            await refreshAveragesFromDB();
            renderAveragesTable();
            showToast('تم حذف متوسط الاستهلاك بنجاح', true);
        }
    );
}

// ==========================================================================
// CONSUMPTION EXCEL IMPORTER WITH TIE MATCHING ASSISTANT
// ==========================================================================
function showImportConsumptionDialog() {
    document.getElementById('consumption-select-file-view').classList.remove('hidden');
    document.getElementById('consumption-sheet-choice-view').classList.add('hidden');
    document.getElementById('consumption-tie-view').classList.add('hidden');
    showModal('modal-import-consumption');
}

async function handleConsumptionFileChosen(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (ev) => {
        try {
            const data = new Uint8Array(ev.target.result);
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(data);
            
            consumptionWorkbook = workbook;
            
            // Populate sheet names select dropdown
            const select = document.getElementById('consumption-sheet-select');
            select.innerHTML = workbook.worksheets.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
            
            document.getElementById('consumption-select-file-view').classList.add('hidden');
            document.getElementById('consumption-sheet-choice-view').classList.remove('hidden');
        } catch (err) {
            showToast('خطأ في تحميل ملف الاستهلاك', false);
        }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
}

async function processConsumptionSheetData() {
    const sheetName = document.getElementById('consumption-sheet-select').value;
    const worksheet = consumptionWorkbook.getWorksheet(sheetName);
    
    const rows = [];
    const totalCols1 = worksheet.columnCount || 100;
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const rowData = [];
        for (let c = 1; c <= totalCols1; c++) { rowData.push(getCellValuePrimitive(row.getCell(c))); }
        rows.push({ rowNum: rowNumber, values: rowData });
    });

    if (rows.length < 2) {
        showToast('الجدول المحدد فارغ أو لا يحتوي على صفوف كافية', false);
        return;
    }

    consumptionSheetHeaders = rows[0].values;
    consumptionSheetRows = rows.slice(1);

    // Identify Columns
    const officeColKey = 'الوحدة/ الطعم';
    const officeColIdx = consumptionSheetHeaders.indexOf(officeColKey);
    if (officeColIdx === -1) {
        showToast(`لم يتم العثور على عمود المكتب الرئيسي بالجدول باسم "${officeColKey}"`, false);
        return;
    }

    // Collect all Excel Office Names and Vaccine Names
    const excelOffices = [];
    consumptionSheetRows.forEach(row => {
        const oName = String(row.values[officeColIdx] || '').trim();
        if (oName && oName !== 'الكود' && oName !== 'المجموع') excelOffices.push(oName);
    });

    const excelVaccines = [];
    for (let c = 1; c < consumptionSheetHeaders.length; c++) {
        const header = consumptionSheetHeaders[c];
        if (header && header !== 'الكود' && !header.includes('Unnamed') && !header.includes('ادخال الشهور')) {
            excelVaccines.push(header);
        }
    }

    // Check for unmatched names to trigger Tie Mapping Assistant
    pendingUnmatchedTies = [];
    
    // Existing system names for dropdown suggestions
    const existingOffices = [...new Set(monthlyAverages.map(a => a.office))].sort();
    const existingVaccines = [...SYSTEM_VACCINES].sort();

    // 1. Check Offices (only flag if existingOffices is non-empty AND name not already tied)
    excelOffices.forEach(o => {
        const translated = translateName('office', o);
        // Already has a tie registered
        const hasTie = nameTies.some(t => t.category === 'office' && t.sourceName === o);
        if (hasTie) return;
        // Exact match in known offices
        const directMatch = existingOffices.find(eo => eo === translated || eo === o);
        if (directMatch) return;
        // Only ask if we actually have offices to compare against
        if (existingOffices.length === 0) return;
        pendingUnmatchedTies.push({
            category: 'office',
            sourceName: o,
            suggestions: existingOffices
        });
    });

    // 2. Check Vaccines (only flag if not already tied)
    excelVaccines.forEach(v => {
        const translated = translateName('vaccine', v);
        const hasTie = nameTies.some(t => t.category === 'vaccine' && t.sourceName === v);
        if (hasTie) return;
        const directMatch = existingVaccines.find(ev => ev.toLowerCase().replace(/\s+/g, '') === translated.toLowerCase().replace(/\s+/g, '') || ev === v);
        if (directMatch) return;
        pendingUnmatchedTies.push({
            category: 'vaccine',
            sourceName: v,
            suggestions: existingVaccines
        });
    });

    if (pendingUnmatchedTies.length > 0) {
        currentTieIndex = 0;
        renderTieAssistantScreen();
    } else {
        // Safe to import directly
        await completeConsumptionImport();
    }
}

function renderTieAssistantScreen() {
    document.getElementById('consumption-sheet-choice-view').classList.add('hidden');
    document.getElementById('consumption-tie-view').classList.remove('hidden');
    
    const container = document.getElementById('tie-questions-container');
    container.innerHTML = '';

    pendingUnmatchedTies.forEach((tie, idx) => {
        const label = tie.category === 'office' ? 'مكتب الصحة' : 'الطعم / اللقاح';
        
        container.innerHTML += `
            <div class="mapping-item glass">
                <span class="form-label text-rose-400">اسم مجهول بالملف (${label}): <strong>"${tie.sourceName}"</strong></span>
                <p class="text-xs text-zinc-400 mb-2">طابق الاسم المجهول مع الاسم المعتمد في نظامك لتسجيل رابط دائم:</p>
                <select id="tie-resolve-dropdown-${idx}" class="form-select">
                    <option value="">— إضافة كاسم جديد معتمد بالنظام —</option>
                    ${tie.suggestions.map(s => `<option value="${s}">${s}</option>`).join('')}
                </select>
            </div>
        `;
    });
}

async function saveActiveTiesAndFinishImport() {
    const backup_payload = [];

    for (let idx = 0; idx < pendingUnmatchedTies.length; idx++) {
        const tie = pendingUnmatchedTies[idx];
        const val = document.getElementById(`tie-resolve-dropdown-${idx}`).value;
        
        if (val) {
            // Persist the name tie mapping
            const item = { sourceName: tie.sourceName, category: tie.category, targetName: val };
            await db.ties.put(item);
            backup_payload.push(item);
        }
    }

    // Refresh Cache
    await refreshTiesFromDB();
    renderNameTiesTable();

    // Log this tie transaction for undo
    if (backup_payload.length > 0) {
        await db.transactions_log.add({
            date: new Date().toISOString(),
            action: 'import_ties',
            payload: JSON.stringify(backup_payload)
        });
    }

    await completeConsumptionImport();
}

async function completeConsumptionImport() {
    const officeColIdx = consumptionSheetHeaders.indexOf('الوحدة/ الطعم');
    const backup_averages = [];

    // Start transaction loop
    for (let row of consumptionSheetRows) {
        const rawOffice = String(row.values[officeColIdx] || '').trim();
        if (!rawOffice || rawOffice === 'الكود' || rawOffice === 'المجموع') continue;

        const officeName = translateName('office', rawOffice);

        for (let colIdx = 1; colIdx < consumptionSheetHeaders.length; colIdx++) {
            const rawVaccine = consumptionSheetHeaders[colIdx];
            if (!rawVaccine || rawVaccine === 'الكود' || rawVaccine.includes('Unnamed') || rawVaccine.includes('ادخال الشهور')) continue;
            
            const vaccineName = translateName('vaccine', rawVaccine);
            const val = parseFloat(row.values[colIdx]) || 0;

            const record = { office: officeName, vaccine: vaccineName, average: Math.round(val) };
            await db.monthly_averages.put(record);
            backup_averages.push(record);
        }
    }

    // Log transaction averages for undo capability
    await db.transactions_log.add({
        date: new Date().toISOString(),
        action: 'import_averages',
        payload: JSON.stringify(backup_averages)
    });

    await refreshAveragesFromDB();
    renderAveragesTable();
    populateExceptionsDropdowns();
    await checkLastTransaction();

    hideModal('modal-import-consumption');
    showToast(`تم استيراد استهلاك مكاتب الصحة بنجاح ومطابقتها`, true);
}

// Transaction Undo Trigger (Rollback last bulk averages/ties import)
async function triggerUndoAction() {
    const last = await db.transactions_log.orderBy('id').last();
    if (!last) return;

    showConfirmModal(
        'التراجع عن الاستيراد',
        `هل ترغب في التراجع عن عملية الاستيراد الأخيرة (${last.action}) وإلغاء كافة التغييرات؟`,
        async () => {
            const payload = JSON.parse(last.payload);
            
            if (last.action === 'import_averages') {
                for (let item of payload) {
                    await db.monthly_averages.delete([item.office, item.vaccine]);
                }
                showToast('تم إلغاء استيراد معدلات الاستهلاك والرجوع للحالة السابقة', true);
            } else if (last.action === 'import_ties') {
                for (let item of payload) {
                    await db.ties.delete(item.sourceName);
                }
                showToast('تم إلغاء روابط مطابقة الأسماء الأخيرة', true);
            }

            // Remove transaction log entry
            await db.transactions_log.delete(last.id);
            
            // Refresh
            await refreshAveragesFromDB();
            await refreshTiesFromDB();
            renderAveragesTable();
            renderNameTiesTable();
            await checkLastTransaction();
        }
    );
}

// ==========================================================================
// NAME TIES MANAGERS
// ==========================================================================
function renderNameTiesTable() {
    const tbody = document.getElementById('name-ties-tbody');
    tbody.innerHTML = '';

    if (nameTies.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-center text-zinc-500 py-12">لا توجد روابط أسماء مسجلة حالياً. سيتم إنشاء روابط عند استيراد ملف استهلاك وتطبيقه.</td></tr>`;
        return;
    }

    nameTies.forEach(t => {
        const label = t.category === 'office' ? 'مكتب صحة / وحدة' : 'طعم لقاح';
        tbody.innerHTML += `
            <tr>
                <td><span class="badge badge-warning">${label}</span></td>
                <td class="font-semibold text-rose-300">"${t.sourceName}"</td>
                <td class="font-semibold text-emerald-400">"${t.targetName}"</td>
                <td>
                    <button onclick="deleteNameTie('${t.sourceName}')" class="btn btn-secondary btn-sm text-rose-400">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </td>
            </tr>
        `;
    });
}

function filterNameTies() {
    const term = document.getElementById('ties-search-input').value.trim().toLowerCase();
    const tbody = document.getElementById('name-ties-tbody');
    const rows = tbody.querySelectorAll('tr');
    if (rows.length === 0 || nameTies.length === 0) return;
    
    nameTies.forEach((t, idx) => {
        const row = rows[idx];
        if (!row) return;
        const label = t.category === 'office' ? 'مكتب صحة / وحدة' : 'طعم لقاح';
        if (t.sourceName.toLowerCase().includes(term) || t.targetName.toLowerCase().includes(term) || label.includes(term)) {
            row.classList.remove('hidden');
        } else {
            row.classList.add('hidden');
        }
    });
}

function showAddTieModal() {
    document.getElementById('form-tie-source').value = '';
    document.getElementById('form-tie-target').value = '';
    showModal('modal-tie-add');
}

async function saveManualTie() {
    const category = document.getElementById('form-tie-category').value;
    const sourceName = document.getElementById('form-tie-source').value.trim();
    const targetName = document.getElementById('form-tie-target').value.trim();

    if (!sourceName || !targetName) {
        showToast('يرجى ملء كافة الحقول الإلزامية المطلوبة', false);
        return;
    }

    await db.ties.put({ sourceName, category, targetName });
    await refreshTiesFromDB();
    renderNameTiesTable();
    hideModal('modal-tie-add');
    showToast('تم إنشاء رابط مطابقة الأسماء بنجاح', true);
}

function deleteNameTie(sourceName) {
    showConfirmModal(
        'حذف رابط الاسم',
        `هل ترغب في حذف رابط مطابقة الاسم المجهول "${sourceName}"؟`,
        async () => {
            await db.ties.delete(sourceName);
            await refreshTiesFromDB();
            renderNameTiesTable();
            showToast('تم إزالة الرابط بنجاح', true);
        }
    );
}

function clearAllTies() {
    showConfirmModal(
        'حذف كافة الروابط',
        'هل أنت متأكد من مسح كافة روابط مطابقة الأسماء المسجلة بالكامل؟ سيتعين عليك مطابقتها يدوياً مجدداً.',
        async () => {
            await db.ties.clear();
            await refreshTiesFromDB();
            renderNameTiesTable();
            showToast('تم إزالة كافة الروابط المسجلة', true);
        }
    );
}

// ==========================================================================
// VACCINE BATCH SAFETY VERIFIER (Merged feature)
// ==========================================================================
function handleBatchUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    document.getElementById('batch-filename').textContent = file.name;
    
    const reader = new FileReader();
    reader.onload = async (ev) => {
        try {
            const data = new Uint8Array(ev.target.result);
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(data);
            
            currentBatchWorkbook = workbook;
            currentBatchSheet = workbook.worksheets[0];
            
            const rows = [];
            const totalColsBatch = currentBatchSheet.columnCount || 100;
            currentBatchSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
                const rowData = [];
                for (let c = 1; c <= totalColsBatch; c++) { rowData.push(getCellValuePrimitive(row.getCell(c))); }
                rows.push({ rowNum: rowNumber, values: rowData });
            });
            
            if (rows.length < 2) {
                showToast('الملف فارغ أو لا يحتوي على تشغيلات كافية', false);
                return;
            }

            batchHeaders = rows[0].values;
            batchRows = rows.slice(1);

            document.getElementById('batch-upload-zone').classList.add('hidden');
            document.getElementById('batch-mapping-container').classList.remove('hidden');
            document.getElementById('batch-results-container').classList.add('hidden');

            renderBatchPreview();
            renderBatchMappingUI();
            
        } catch (err) {
            showToast('خطأ في تحميل الملف.', false);
        }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
}

function renderBatchPreview() {
    const table = document.getElementById('batch-preview-table');
    table.innerHTML = '';
    
    let headerRowHTML = '<tr class="bg-slate-900">';
    batchHeaders.forEach(h => { headerRowHTML += `<th>${h || '(فارغ)'}</th>`; });
    headerRowHTML += '</tr>';
    
    let bodyRowsHTML = '';
    batchRows.slice(0, 5).forEach(row => {
        bodyRowsHTML += '<tr>';
        row.values.forEach(cell => { bodyRowsHTML += `<td>${cell !== null ? cell : ''}</td>`; });
        bodyRowsHTML += '</tr>';
    });
    
    table.innerHTML = headerRowHTML + bodyRowsHTML;
}

function renderBatchMappingUI() {
    const container = document.getElementById('batch-mapping-fields');
    container.innerHTML = '';

    const systemFields = [
        { key: 'batchId', label: 'رقم التشغيلة بالملف (مطلوب)', required: true },
        { key: 'type', label: 'نوع اللقاح بالملف', required: false },
        { key: 'expiry', label: 'تاريخ انتهاء الصلاحية بالملف', required: false }
    ];

    batchMapping = {};

    systemFields.forEach(field => {
        let bestGuess = '';
        const fKey = field.key;
        
        batchHeaders.forEach(h => {
            const hLow = String(h).toLowerCase();
            if (fKey === 'batchId' && (hLow.includes('تشغيل') || hLow.includes('batch') || hLow.includes('lot') || hLow.includes('رقم'))) bestGuess = h;
            else if (fKey === 'type' && (hLow.includes('طعم') || hLow.includes('نوع') || hLow.includes('vacc') || hLow.includes('اسم'))) bestGuess = h;
            else if (fKey === 'expiry' && (hLow.includes('انتهاء') || hLow.includes('exp') || hLow.includes('تاريخ'))) bestGuess = h;
        });

        batchMapping[fKey] = bestGuess;

        container.innerHTML += `
            <div class="mapping-item glass">
                <span class="form-label">${field.label}</span>
                <select id="select-map-batch-${fKey}" class="mapping-select">
                    <option value="">— تجاهل هذا الحقل —</option>
                    ${batchHeaders.map(h => `<option value="${h}" ${h === bestGuess ? 'selected' : ''}>${h}</option>`).join('')}
                </select>
            </div>
        `;
    });
}

async function runBatchValidation() {
    const keys = ['batchId', 'type', 'expiry'];
    keys.forEach(k => {
        batchMapping[k] = document.getElementById(`select-map-batch-${k}`).value;
    });

    if (!batchMapping.batchId) return showToast('يرجى تحديد عمود رقم التشغيلة بالملف', false);

    const batchColIdx = batchHeaders.indexOf(batchMapping.batchId);
    const typeColIdx = batchMapping.type ? batchHeaders.indexOf(batchMapping.type) : -1;
    const expiryColIdx = batchMapping.expiry ? batchHeaders.indexOf(batchMapping.expiry) : -1;

    batchResults = [];
    let validCount = 0;
    let mismatchCount = 0;
    let unregisteredCount = 0;

    batchRows.forEach(row => {
        const batchId = String(row.values[batchColIdx] || '').trim();
        if (!batchId) return;

        // Apply ties translation to vaccine type if mapped
        let rawType = typeColIdx !== -1 ? String(row.values[typeColIdx] || '').trim() : '';
        const type = translateName('vaccine', rawType);

        const expiryRaw = expiryColIdx !== -1 ? row.values[expiryColIdx] : null;

        const found = validBatches.find(b => String(b.batchId).toLowerCase() === batchId.toLowerCase());
        
        let status = 'valid';
        let notes = '';

        if (!found) {
            status = 'unregistered';
            notes = 'رقم التشغيلة هذا غير مسجل بقاعدة بيانات التشغيلات المعتمدة';
            unregisteredCount++;
        } else {
            let mismatches = [];
            
            if (expiryColIdx !== -1 && expiryRaw) {
                const sheetExpDate = parseArabicDate(expiryRaw);
                const dbExpDate = parseArabicDate(found.expiry);
                if (sheetExpDate && dbExpDate && sheetExpDate.toDateString() !== dbExpDate.toDateString()) {
                    mismatches.push(`اختلاف تاريخ الصلاحية (الملف: ${formatDateToArabic(sheetExpDate)} • الدليل: ${formatDateToArabic(dbExpDate)})`);
                }
            }

            if (typeColIdx !== -1 && type && found.type) {
                const t1 = type.toLowerCase().replace(/\s+/g, '');
                const t2 = found.type.toLowerCase().replace(/\s+/g, '');
                if (!t1.includes(t2) && !t2.includes(t1)) {
                    mismatches.push(`اختلاف نوع الطعم (الملف: ${type} • الدليل: ${found.type})`);
                }
            }

            if (mismatches.length > 0) {
                status = 'mismatch';
                notes = mismatches.join(' | ');
                mismatchCount++;
            } else {
                notes = 'مطابق ومعتمد بالدليل';
                validCount++;
            }
        }

        const originalRow = {};
        batchHeaders.forEach((h, idx) => { originalRow[h] = row.values[idx]; });

        batchResults.push({
            rowNum: row.rowNum,
            batchId,
            type,
            expiryRaw,
            status,
            notes,
            matchedRecord: found,
            originalRow
        });
    });

    // Save to DB log
    await db.batch_history.add({
        date: new Date(),
        filename: document.getElementById('batch-filename').textContent,
        total: batchResults.length,
        valid: validCount,
        mismatch: mismatchCount,
        invalid: unregisteredCount
    });

    document.getElementById('batch-results-summary-text').innerHTML = `
        تم مراجعة <strong class="text-white">${batchResults.length}</strong> تشغيلة. 
        النتائج: <strong class="text-emerald-400">${validCount}</strong> معتمدة • 
        <strong class="text-amber-400">${mismatchCount}</strong> غير متطابقة • 
        <strong class="text-rose-400">${unregisteredCount}</strong> غير مسجلة.
    `;

    document.getElementById('batch-mapping-container').classList.add('hidden');
    document.getElementById('batch-results-container').classList.remove('hidden');

    renderBatchResultsTable();
    showToast('اكتمل فحص ومطابقة أرقام التشغيلات', unregisteredCount === 0 && mismatchCount === 0);
}

function renderBatchResultsTable() {
    const tbody = document.getElementById('batch-results-tbody');
    tbody.innerHTML = '';

    batchResults.forEach(r => {
        let badgeHTML = '';
        let rowClass = '';
        if (r.status === 'valid') {
            badgeHTML = '<span class="badge badge-success">معتمد ومطابق</span>';
        } else if (r.status === 'mismatch') {
            badgeHTML = '<span class="badge badge-warning">اختلاف بيانات</span>';
            rowClass = 'row-has-issues';
        } else {
            badgeHTML = '<span class="badge badge-danger">غير مسجل بالدليل</span>';
            rowClass = 'row-expired';
        }

        tbody.innerHTML += `
            <tr class="${rowClass}">
                <td>${badgeHTML}</td>
                <td class="font-mono text-zinc-400">#${r.rowNum}</td>
                <td class="font-mono font-semibold">${r.batchId}</td>
                <td>${r.type || '—'}</td>
                <td class="font-mono">${r.expiryRaw || '—'}</td>
                <td class="text-sm font-semibold">${r.notes}</td>
            </tr>
        `;
    });
}

async function exportBatchExcel(mode = 'full') {
    if (batchResults.length === 0) return;

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Batches Validation');
    worksheet.views = [{ rtl: true, showGridLines: true }];

    const cols = batchHeaders.map(h => ({ header: h, key: h, width: 20 }));
    cols.push({ header: 'حالة الاعتماد بالدليل', key: 'status_check', width: 22 });
    cols.push({ header: 'ملاحظات التحقق والمخالفات', key: 'notes_check', width: 45 });
    worksheet.columns = cols;

    worksheet.getRow(1).eachCell(c => {
        c.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFF' } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '6D28D9' } };
        c.alignment = { horizontal: 'center' };
    });

    let records = batchResults;
    if (mode === 'unregistered') records = batchResults.filter(r => r.status === 'unregistered');
    else if (mode === 'mismatch') records = batchResults.filter(r => r.status === 'mismatch');

    records.forEach(r => {
        const rowData = { ...r.originalRow };
        rowData['status_check'] = r.status === 'valid' ? 'معتمد' : (r.status === 'mismatch' ? 'مختلف البيانات' : 'غير مسجل');
        rowData['notes_check'] = r.notes;

        const row = worksheet.addRow(rowData);
        
        if (r.status === 'unregistered') {
            row.eachCell(cell => {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCDD2' } };
            });
        } else if (r.status === 'mismatch') {
            row.eachCell(cell => {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9C4' } };
            });
        }
    });

    worksheet.columns.forEach(column => {
        let maxLen = 0;
        column.eachCell({ includeEmpty: true }, cell => {
            const val = cell.value ? String(cell.value) : '';
            if (val.length > maxLen) maxLen = val.length;
        });
        column.width = Math.max(maxLen + 4, 15);
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `VaxGuard_BatchCheck_${mode}_${new Date().toISOString().split('T')[0]}.xlsx`;
    link.click();
}

function addAllUnregisteredToDB() {
    const unregs = batchResults.filter(r => r.status === 'unregistered');
    if (unregs.length === 0) return showToast('لا توجد تشغيلات غير معتمدة لإضافتها', false);

    showConfirmModal(
        'إضافة تشغيلات جديدة لدليل المعتمد',
        `هل ترغب في إضافة عدد (${unregs.length}) تشغيلة غير مسجلة حالياً تلقائياً لدليل المعتمد بالوزارة؟`,
        async () => {
            let added = 0;
            const backup_added = [];
            
            for (let r of unregs) {
                const item = {
                    batchId: r.batchId,
                    type: r.type || 'Pfizer',
                    manufacturer: 'مستورد تلقائي',
                    expiry: r.expiryRaw ? parseArabicDate(r.expiryRaw)?.toISOString().split('T')[0] || '' : '',
                    notes: 'أُضيفت تلقائياً من ملف الفحص'
                };
                
                const exists = await db.batches.get(item.batchId);
                if (!exists) {
                    await db.batches.put(item);
                    backup_added.push(item);
                    added++;
                }
            }

            // Save transaction to rollback
            await db.transactions_log.add({
                date: new Date().toISOString(),
                action: 'add_batches',
                payload: JSON.stringify(backup_added)
            });

            await refreshBatchesFromDB();
            renderBatchDBTable();
            await checkLastTransaction();
            
            showToast(`تم إضافة ${added} تشغيلة معتمدة جديدة للدليل`, true);
            runBatchValidation();
        }
    );
}

// ==========================================================================
// VALID BATCHES DATABASE MANAGEMENT
// ==========================================================================
function renderBatchDBTable() {
    const tbody = document.getElementById('batch-db-tbody');
    tbody.innerHTML = '';

    if (validBatches.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center text-zinc-500 py-12">لا توجد تشغيلات مسجلة بالدليل حالياً. يمكنك الإضافة يدوياً أو الاستيراد من ملف.</td></tr>`;
        return;
    }

    validBatches.forEach(b => {
        tbody.innerHTML += `
            <tr id="batch-row-${b.batchId}">
                <td class="font-mono text-violet-300 font-semibold">${b.batchId}</td>
                <td><span class="badge badge-success">${b.type}</span></td>
                <td>${b.manufacturer || '—'}</td>
                <td class="font-mono">${b.expiry || '—'}</td>
                <td class="text-xs text-zinc-400">${b.notes || '—'}</td>
                <td>
                    <div class="flex gap-2">
                        <button onclick="editBatchDB('${b.batchId}')" class="btn btn-secondary btn-sm"><i class="fa-solid fa-pen-to-square"></i></button>
                        <button onclick="deleteBatchDB('${b.batchId}')" class="btn btn-secondary btn-sm text-rose-400"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </td>
            </tr>
        `;
    });
}

function filterBatchDBTable() {
    const term = document.getElementById('batch-db-search').value.trim().toLowerCase();
    validBatches.forEach(b => {
        const row = document.getElementById(`batch-row-${b.batchId}`);
        if (!row) return;
        
        if (b.batchId.toLowerCase().includes(term) || b.type.toLowerCase().includes(term)) {
            row.classList.remove('hidden');
        } else {
            row.classList.add('hidden');
        }
    });
}

function showAddBatchModal() {
    document.getElementById('modal-batch-title').textContent = 'إضافة تشغيلة معتمدة جديدة';
    document.getElementById('form-batch-id').value = '';
    document.getElementById('form-batch-id').disabled = false;
    document.getElementById('form-batch-old-id').value = '';
    document.getElementById('form-batch-type').value = '';
    document.getElementById('form-batch-manuf').value = '';
    document.getElementById('form-batch-expiry').value = '';
    document.getElementById('form-batch-notes').value = '';

    showModal('modal-batch-edit');
}

function editBatchDB(batchId) {
    const b = validBatches.find(x => x.batchId === batchId);
    if (!b) return;

    document.getElementById('modal-batch-title').textContent = 'تعديل بيانات تشغيلة معتمدة';
    document.getElementById('form-batch-id').value = b.batchId;
    document.getElementById('form-batch-id').disabled = true;
    document.getElementById('form-batch-old-id').value = b.batchId;
    document.getElementById('form-batch-type').value = b.type;
    document.getElementById('form-batch-manuf').value = b.manufacturer;
    document.getElementById('form-batch-expiry').value = b.expiry;
    document.getElementById('form-batch-notes').value = b.notes || '';

    showModal('modal-batch-edit');
}

async function saveBatchFromForm() {
    const batchId = document.getElementById('form-batch-id').value.trim();
    const type = document.getElementById('form-batch-type').value.trim() || 'Pfizer';
    const manufacturer = document.getElementById('form-batch-manuf').value.trim();
    const expiry = document.getElementById('form-batch-expiry').value;
    const notes = document.getElementById('form-batch-notes').value.trim();

    if (!batchId) {
        showToast('يرجى كتابة رقم التشغيلة للتعريف', false);
        return;
    }

    const item = { batchId, type, manufacturer, expiry, notes };
    const oldId = document.getElementById('form-batch-old-id').value;

    if (oldId && oldId !== batchId) {
        await db.batches.delete(oldId);
    }

    await db.batches.put(item);
    await refreshBatchesFromDB();
    renderBatchDBTable();
    hideModal('modal-batch-edit');
    showToast('تم حفظ التشغيلة المعتمدة بنجاح للتحققات', true);
}

function deleteBatchDB(batchId) {
    showConfirmModal(
        'حذف تشغيلة معتمدة',
        `هل ترغب في إزالة التشغيلة رقم (${batchId}) نهائياً من قاعدة بيانات التحقق؟`,
        async () => {
            await db.batches.delete(batchId);
            await refreshBatchesFromDB();
            renderBatchDBTable();
            showToast('تم إزالة التشغيلة من قاعدة البيانات بنجاح', true);
        }
    );
}

function clearAllBatchDB() {
    showConfirmModal(
        'مسح كافة تشغيلات الدليل',
        'تحذير! هل أنت متأكد من رغبتك في حذف دليل تشغيلات اللقاحات بالكامل؟ لا يمكن استعادة البيانات بعد ذلك.',
        async () => {
            await db.batches.clear();
            await refreshBatchesFromDB();
            renderBatchDBTable();
            showToast('تم تفريغ الدليل ومسح البيانات', true);
        }
    );
}

function exportBatchDBJSON() {
    const blob = new Blob([JSON.stringify(validBatches, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "VaxGuard_Batches.json";
    a.click();
    showToast('تم تصدير الدليل بنجاح', true);
}

function importBatchDBJSON() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = e => {
        const reader = new FileReader();
        reader.onload = async ev => {
            try {
                const arr = JSON.parse(ev.target.result);
                if (!Array.isArray(arr)) throw new Error('Not array');
                
                await db.batches.clear();
                await db.batches.bulkPut(arr);
                await refreshBatchesFromDB();
                renderBatchDBTable();
                showToast('تم استيراد التشغيلات بنجاح للمطابقة', true);
            } catch (err) {
                showToast('الملف تالف أو غير صالح للبناء', false);
            }
        };
        reader.readAsText(e.target.files[0]);
    };
    input.click();
}

// ==========================================================================
// DATA ANALYSIS & SCIENTIFIC DASHBOARD (For data analysis scientists)
// ==========================================================================
async function renderDashboardData() {
    const uniqueOffices = new Set(stockResults.map(r => r.office));
    document.getElementById('dash-stat-offices').textContent = uniqueOffices.size;
    
    const totalDoses = stockResults.reduce((acc, r) => acc + r.remaining, 0);
    document.getElementById('dash-stat-doses').textContent = totalDoses.toLocaleString();
    
    const offendingOffices = new Set(stockResults.filter(r => r.issues.length > 0).map(r => r.office));
    document.getElementById('dash-stat-issues').textContent = offendingOffices.size;

    const expiryTbody = document.getElementById('dash-expiry-table');
    expiryTbody.innerHTML = '';
    
    const activeExpiries = stockResults.filter(r => r.expiryDate !== null && r.expiryDate !== undefined);
    activeExpiries.sort((a, b) => a.expiryDate - b.expiryDate);

    if (activeExpiries.length === 0) {
        expiryTbody.innerHTML = `<tr><td colspan="6" class="text-center text-zinc-500 py-8">${t('empty_expiry')}</td></tr>`;
    } else {
        activeExpiries.slice(0, 5).forEach(r => {
            const today = new Date();
            const daysRemaining = Math.ceil((r.expiryDate - today) / (1000 * 60 * 60 * 24));
            
            let threatBadge = '<span class="badge badge-success">صالح وآمن</span>';
            if (daysRemaining < 0) threatBadge = '<span class="badge badge-danger">منتهي تماماً</span>';
            else if (daysRemaining <= 90) threatBadge = '<span class="badge badge-warning">انتهاء قريب</span>';

            expiryTbody.innerHTML += `
                <tr>
                    <td><strong>${r.office}</strong></td>
                    <td>${r.vaccine}</td>
                    <td class="font-mono text-zinc-400">${r.batchId || '—'}</td>
                    <td class="font-mono text-rose-300 font-semibold">${formatDateToArabic(r.expiryDate)}</td>
                    <td class="font-mono">${r.remaining}</td>
                    <td>${threatBadge}</td>
                </tr>
            `;
        });
    }

    const vaccineTotals = {};
    stockResults.forEach(r => {
        vaccineTotals[r.vaccine] = (vaccineTotals[r.vaccine] || 0) + r.remaining;
    });

    const labelsC1 = Object.keys(vaccineTotals);
    const dataC1 = Object.values(vaccineTotals);

    if (dosesDistChart) dosesDistChart.destroy();
    dosesDistChart = new Chart(document.getElementById('chart-doses-dist').getContext('2d'), {
        type: 'bar',
        data: {
            labels: labelsC1,
            datasets: [{
                label: t('col_total_remaining'),
                data: dataC1,
                backgroundColor: isDark ? 'rgba(167, 139, 250, 0.4)' : 'rgba(167, 139, 250, 0.7)',
                borderColor: '#a78bfa',
                borderWidth: 1.5,
                borderRadius: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { backgroundColor: '#111322', titleColor: '#fff', bodyColor: '#ccc' }
            },
            scales: {
                x: { ticks: { color: isDark ? '#94a3b8' : '#64748b' }, grid: { display: false } },
                y: { ticks: { color: isDark ? '#94a3b8' : '#64748b' }, grid: { color: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(9,9,11,0.05)' } }
            }
        }
    });

    let expiredIssueCount = 0;
    let capacityIssueCount = 0;
    let wastageIssueCount = 0;
    let excessiveIssueCount = 0;

    stockResults.forEach(r => {
        r.issues.forEach(i => {
            if (i.includes('منتهي') || i.includes('صيغة')) expiredIssueCount++;
            else if (i.includes('عبوات') || i.includes('جرعة')) capacityIssueCount++;
            else if (i.includes('فاقد') || i.includes('تالف') || i.includes('معدم') || i.includes('هادر')) wastageIssueCount++;
            else if (i.includes('تخزين زائد')) excessiveIssueCount++;
        });
    });

    const labelsC2 = [
        t('rule_expiry'),
        t('rule_vial_capacity_match'),
        t('rule_wastage_bounds'),
        t('rule_excessive_stock')
    ];
    const dataC2 = [expiredIssueCount, capacityIssueCount, wastageIssueCount, excessiveIssueCount];

    if (issuesRadarChart) issuesRadarChart.destroy();
    issuesRadarChart = new Chart(document.getElementById('chart-issues-radar').getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: labelsC2,
            datasets: [{
                data: dataC2,
                backgroundColor: ['#fb7185', '#c4b5fd', '#fbbf24', '#22d3ee'],
                borderWidth: 0,
                hoverOffset: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'right',
                    labels: { color: isDark ? '#94a3b8' : '#64748b', font: { size: 11 } }
                },
                tooltip: { backgroundColor: '#111322' }
            },
            cutout: '70%'
        }
    });
}

// ==========================================================================
// REPORTS & HISTORY LOGS
// ==========================================================================
async function renderHistoryLogList() {
    const list = document.getElementById('history-log-list');
    list.innerHTML = '';

    const stocks = await db.stock_history.orderBy('date').reverse().toArray();
    
    if (stocks.length === 0) {
        list.innerHTML = `<div class="text-center text-zinc-500 py-12 glass rounded-3xl">${t('empty_reports')}</div>`;
        return;
    }

    stocks.forEach((item) => {
        const timeText = new Date(item.date).toLocaleString('ar-EG');
        const countClean = item.totalRows - item.details.length;
        
        list.innerHTML += `
            <div onclick="showHistoryDetail(${item.id})" class="history-item-card glass p-6 rounded-3xl cursor-pointer border border-transparent hover:border-violet-500/50 hover:bg-zinc-800/10 transition-all flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                    <h4 class="font-semibold text-white truncate max-w-320">${item.filename}</h4>
                    <span class="text-xs text-zinc-500 mt-1 block"><i class="fa-solid fa-calendar mr-1"></i> ${timeText}</span>
                </div>
                <div class="flex gap-4">
                    <div class="text-center">
                        <div class="text-emerald-400 text-lg font-bold">${countClean}</div>
                        <span class="text-[10px] text-zinc-500">مكاتب سليمة</span>
                    </div>
                    <div class="text-center border-right border-zinc-700/50 pr-4">
                        <div class="text-rose-400 text-lg font-bold">${item.totalIssues}</div>
                        <span class="text-[10px] text-zinc-500">مخالفات مرصودة</span>
                    </div>
                    <div class="text-center border-right border-zinc-700/50 pr-4">
                        <div class="text-zinc-300 text-lg font-bold">${item.totalRows}</div>
                        <span class="text-[10px] text-zinc-500">إجمالي المكاتب</span>
                    </div>
                </div>
            </div>
        `;
    });
}

let activeHistoryItem = null;

async function showHistoryDetail(id) {
    const item = await db.stock_history.get(id);
    if (!item) return;

    activeHistoryItem = item;
    
    document.getElementById('history-detail-title').textContent = item.filename;
    document.getElementById('history-detail-meta').innerHTML = `
        <i class="fa-solid fa-clock"></i> وقت الفحص: ${new Date(item.date).toLocaleString('ar-EG')} <br>
        <i class="fa-solid fa-file"></i> إجمالي سجلات الجدول: ${item.totalRows}
    `;

    const cleanCount = item.totalRows - item.details.length;
    document.getElementById('hist-detail-clean-count').textContent = cleanCount;
    document.getElementById('hist-detail-issues-count').textContent = item.details.length;
    document.getElementById('hist-detail-total-count').textContent = item.totalRows;

    const detailsList = document.getElementById('history-detail-issues-list');
    detailsList.innerHTML = '';

    if (item.details.length === 0) {
        detailsList.innerHTML = `<div class="text-emerald-400 text-center py-4 font-semibold">كل سجلات هذا التقرير سليمة تماماً!</div>`;
    } else {
        item.details.forEach(d => {
            detailsList.innerHTML += `
                <div class="bg-zinc-900/60 p-4 rounded-xl border border-rose-500/20">
                    <strong class="text-white text-sm block mb-1">${d.office} • ${d.vaccine}</strong>
                    <div class="text-xs text-rose-300 space-y-1 mt-1">
                        ${d.issues.map(iss => `• ${iss}`).join('<br>')}
                    </div>
                </div>
            `;
        });
    }

    showModal('modal-history-detail');

    if (historyPieChart) historyPieChart.destroy();
    historyPieChart = new Chart(document.getElementById('history-pie-chart').getContext('2d'), {
        type: 'pie',
        data: {
            labels: [t('filter_clean'), t('filter_issue')],
            datasets: [{
                data: [cleanCount, item.details.length],
                backgroundColor: ['#34d399', '#fb7185'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { color: '#94a3b8' } }
            }
        }
    });
}

// BUG FIX: Re-implement "تصدير التقرير مجدداً" from history log database details
async function exportHistoryReportFile() {
    if (!activeHistoryItem) return;

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('History Issues Summary');
    worksheet.views = [{ rtl: true, showGridLines: true }];

    worksheet.columns = [
        { header: 'مكتب الصحة', key: 'office', width: 25 },
        { header: 'طعم اللقاح', key: 'vaccine', width: 25 },
        { header: 'المخالفات والملاحظات المرصودة', key: 'issues', width: 60 }
    ];

    worksheet.getRow(1).eachCell(c => {
        c.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFF' } };
        row.eachCell(c => {
            c.fill = expiredFill;
            c.border = expiredBorder;
        });
    });

    worksheet.columns.forEach(column => {
        let maxLen = 0;
        column.eachCell({ includeEmpty: true }, cell => {
            const val = cell.value ? String(cell.value) : '';
            if (val.length > maxLen) maxLen = val.length;
        });
        column.width = Math.max(maxLen + 4, 15);
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `VaxGuard_HistoricalCheck_Summary_${activeHistoryItem.id}.xlsx`;
    link.click();
    showToast('تم تصدير تقرير المخالفات التاريخي المنسق بنجاح', true);
}

function clearHistoryLog() {
    showConfirmModal(
        'مسح سجل التقارير التاريخية',
        'هل ترغب في حذف كافة تقارير الفحوصات المسجلة بقاعدة البيانات نهائياً؟ هذا الإجراء لا تراجع عنه.',
        async () => {
            await db.stock_history.clear();
            await db.batch_history.clear();
            await renderHistoryLogList();
            showToast('تم تصفير سجل العمليات التاريخية بنجاح', true);
        }
    );
}

// Backup system package JSON
// Backup system package JSON
async function exportBackupPackage() {
    const backup = {
        batches: await db.batches.toArray(),
        monthly_averages: await db.monthly_averages.toArray(),
        stock_history: await db.stock_history.toArray(),
        batch_history: await db.batch_history.toArray(),
        rules_config: await db.rules_config.toArray(),
        exceptions: await db.exceptions.toArray(),
        ties: await db.ties.toArray(),
        vaccine_capacities: await db.vaccine_capacities.toArray(),
        settings: settings
    };

    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `VaxGuardPro_Backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    showToast('تم تصدير حزمة النسخ الاحتياطي للنظام بنجاح', true);
}

function importBackupPackage() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = e => {
        const reader = new FileReader();
        reader.onload = async ev => {
            try {
                const data = JSON.parse(ev.target.result);
                
                if (data.batches) {
                    await db.batches.clear();
                    await db.batches.bulkPut(data.batches);
                }
                if (data.monthly_averages) {
                    await db.monthly_averages.clear();
                    await db.monthly_averages.bulkPut(data.monthly_averages);
                }
                if (data.stock_history) {
                    await db.stock_history.clear();
                    await db.stock_history.bulkPut(data.stock_history);
                }
                if (data.batch_history) {
                    await db.batch_history.clear();
                    await db.batch_history.bulkPut(data.batch_history);
                }
                if (data.rules_config) {
                    await db.rules_config.clear();
                    await db.rules_config.bulkPut(data.rules_config);
                }
                if (data.exceptions) {
                    await db.exceptions.clear();
                    await db.exceptions.bulkPut(data.exceptions);
                }
                if (data.ties) {
                    await db.ties.clear();
                    await db.ties.bulkPut(data.ties);
                }
                if (data.vaccine_capacities) {
                    await db.vaccine_capacities.clear();
                    await db.vaccine_capacities.bulkPut(data.vaccine_capacities);
                }
                if (data.settings) {
                    settings = { ...settings, ...data.settings };
                    localStorage.setItem('vaxguard_settings', JSON.stringify(settings));
                }

                await refreshBatchesFromDB();
                await refreshAveragesFromDB();
                await refreshTiesFromDB();
                await refreshExceptionsFromDB();
                await refreshRulesFromDB();
                await refreshCapacitiesFromDB();
                applySettingsToUI();
                renderBatchDBTable();
                renderAveragesTable();
                renderNameTiesTable();
                renderHistoryLogList();
                renderRulesControlUI();
                populateExceptionsDropdowns();

                showToast('تم استعادة حزمة البيانات بنجاح للنظام', true);
            } catch (err) {
                showToast('فشل استيراد النسخة الاحتياطية. صيغة تالفة.', false);
            }
        };
        reader.readAsText(e.target.files[0]);
    };
    input.click();
}

// ==========================================================================
// VACCINE CAPACITIES MANAGEMENT FUNCTIONS
// ==========================================================================
async function refreshCapacitiesFromDB() {
    vaccineCapacities = await db.vaccine_capacities.toArray();
    renderCapacitiesTable();
}

// ==========================================================================
// UNIFIED VACCINE RULES MANAGEMENT FUNCTIONS
// ==========================================================================
async function refreshVaccineRulesFromDB() {
    vaccineRules = await db.vaccine_rules.toArray();
    renderVaccineRulesTable();
}

async function seedDefaultVaccineRules() {
    const count = await db.vaccine_rules.count();
    if (count === 0) {
        const defaults = [
            { vaccine: 'MMR',                               dosesPerVial: 10, wastageAllowed: true,  destroyedAllowed: true,  checkDoses: true, checkRemaining: true  },
            { vaccine: 'بى سى جى',                          dosesPerVial: 20, wastageAllowed: true,  destroyedAllowed: true,  checkDoses: true, checkRemaining: true  },
            { vaccine: 'شلل أطفال سابين',                   dosesPerVial: 1,  wastageAllowed: true,  destroyedAllowed: false , checkDoses: true, checkRemaining: false },
            { vaccine: 'الخماسى',                           dosesPerVial: 1,  wastageAllowed: false, destroyedAllowed: false , checkDoses: true, checkRemaining: false },
            { vaccine: 'الثلاثى',                           dosesPerVial: 1,  wastageAllowed: false, destroyedAllowed: false , checkDoses: true, checkRemaining: false },
            { vaccine: 'شلل أطفال سولك',                    dosesPerVial: 1,  wastageAllowed: false, destroyedAllowed: false , checkDoses: true, checkRemaining: false },
            { vaccine: 'ثنائى',                             dosesPerVial: 1,  wastageAllowed: false, destroyedAllowed: false , checkDoses: true, checkRemaining: false },
            { vaccine: 'كبدى B',                            dosesPerVial: 1,  wastageAllowed: false, destroyedAllowed: false , checkDoses: true, checkRemaining: false },
            { vaccine: 'فيتامين أ 100.000 وحدة دولية',       dosesPerVial: 1,  wastageAllowed: false, destroyedAllowed: false },
            { vaccine: 'فيتامين أ 200.000 وحدة دولية',       dosesPerVial: 1,  wastageAllowed: false, destroyedAllowed: false },
        ];
        await db.vaccine_rules.bulkPut(defaults);
    }
}

function renderVaccineRulesTable() {
    const tbody = document.getElementById('vaccine-rules-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (vaccineRules.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-zinc-500 py-8">لا توجد قواعد مسجلة. قم بتحميل ملف إكسيل أو أضف يدوياً.</td></tr>';
        return;
    }

    vaccineRules.forEach(function(r) {
        var vn = (r.vaccine || '').replace(/'/g, '&#39;');
        tbody.innerHTML += '<tr>' +
            '<td><strong>' + r.vaccine + '</strong></td>' +
            '<td style="text-align:center"><input type="number" min="1" value="' + r.dosesPerVial + '" style="width:72px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:4px 6px;color:var(--text);text-align:center" ' +
                'onchange="updateVaccineRuleDoses(&#39;' + vn + '&#39;, this.value)"></td>' +
            '<td style="text-align:center"><label class="toggle-switch"><input type="checkbox" ' + (r.checkDoses !== false ? 'checked' : '') + ' onchange="updateVaccineRuleToggle(&#39;' + vn + '&#39;, &#39;checkDoses&#39;, this.checked)"><span class="slider-toggle"></span></label></td>' +
            '<td style="text-align:center"><label class="toggle-switch"><input type="checkbox" ' + (r.checkRemaining === true ? 'checked' : '') + ' onchange="updateVaccineRuleToggle(&#39;' + vn + '&#39;, &#39;checkRemaining&#39;, this.checked)"><span class="slider-toggle"></span></label></td>' +
            '<td style="text-align:center"><label class="toggle-switch"><input type="checkbox" ' + (r.wastageAllowed ? 'checked' : '') + ' onchange="updateVaccineRuleToggle(&#39;' + vn + '&#39;, &#39;wastageAllowed&#39;, this.checked)"><span class="slider-toggle"></span></label></td>' +
            '<td style="text-align:center"><label class="toggle-switch"><input type="checkbox" ' + (r.destroyedAllowed ? 'checked' : '') + ' onchange="updateVaccineRuleToggle(&#39;' + vn + '&#39;, &#39;destroyedAllowed&#39;, this.checked)"><span class="slider-toggle"></span></label></td>' +
            '<td style="text-align:center"><button onclick="deleteVaccineRule(&#39;' + vn + '&#39;)" class="btn btn-secondary btn-sm" title="حذف" style="color:var(--rose);border-color:rgba(239,68,68,0.3)"><i class="fa-solid fa-trash-can"></i></button></td>' +
            '</tr>';
    });
}

async function addVaccineRule() {
    var name   = document.getElementById('vr-name').value.trim();
    var doses  = parseInt(document.getElementById('vr-doses').value, 10) || 1;
    var wast   = document.getElementById('vr-wastage').checked;
    var dest   = document.getElementById('vr-destroyed').checked;
    if (!name) return showToast('يرجى كتابة اسم الطعم أو اللقاح', false);
    var chkD = document.getElementById('vr-check-doses').checked;
    var chkR = document.getElementById('vr-check-remaining').checked;
    await db.vaccine_rules.put({ vaccine: name, dosesPerVial: doses, wastageAllowed: wast, destroyedAllowed: dest, checkDoses: chkD, checkRemaining: chkR });
    await refreshVaccineRulesFromDB();
    document.getElementById('vr-name').value = '';
    document.getElementById('vr-doses').value = '';
    document.getElementById('vr-wastage').checked = false;
    document.getElementById('vr-destroyed').checked = false;
    showToast('تم حفظ قاعدة الطعم بنجاح', true);
}

async function updateVaccineRuleDoses(vaccine, val) {
    var doses = parseInt(val, 10) || 1;
    var existing = await db.vaccine_rules.get(vaccine);
    if (existing) {
        existing.dosesPerVial = doses;
        await db.vaccine_rules.put(existing);
        vaccineRules = await db.vaccine_rules.toArray();
    }
}

async function updateVaccineRuleToggle(vaccine, field, checked) {
    var existing = await db.vaccine_rules.get(vaccine);
    if (existing) {
        existing[field] = checked;
        await db.vaccine_rules.put(existing);
        vaccineRules = await db.vaccine_rules.toArray();
    }
}

async function deleteVaccineRule(vaccine) {
    showConfirmModal('حذف قاعدة طعم', 'هل ترغب في حذف قاعدة طعم (' + vaccine + ')؟', async function() {
        await db.vaccine_rules.delete(vaccine);
        await refreshVaccineRulesFromDB();
        showToast('تم حذف القاعدة بنجاح', true);
    });
}

// File upload for extracting vaccine names
let vrWorkbook = null;
let vrHeaders  = [];

function handleVaccineRulesFile(e) {
    var file = e.target.files[0] || (e.dataTransfer && e.dataTransfer.files[0]);
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function(ev) {
        try {
            var data = new Uint8Array(ev.target.result);
            var wb = new ExcelJS.Workbook();
            await wb.xlsx.load(data);
            vrWorkbook = wb;
            var ws = wb.worksheets[0];
            var totalCols = ws.columnCount || 50;
            vrHeaders = [];
            for (var c = 1; c <= totalCols; c++) {
                var v = ws.getRow(1).getCell(c).value;
                if (v) vrHeaders.push({ col: c, name: String(v) });
            }
            // Populate column selector
            var sel = document.getElementById('vr-col-select');
            sel.innerHTML = vrHeaders.map(function(h) {
                return '<option value="' + h.col + '">' + h.name + '</option>';
            }).join('');
            // Auto-select column with vaccine-like header
            var autoIdx = vrHeaders.findIndex(function(h) {
                var l = h.name.toLowerCase();
                return l.includes('طعم') || l.includes('لقاح') || l.includes('vacc');
            });
            if (autoIdx >= 0) sel.selectedIndex = autoIdx;
            document.getElementById('vr-col-panel').classList.remove('hidden');
            document.getElementById('vr-upload-label').textContent = '✓ ' + file.name;
            showToast('تم تحميل الملف — اختر عمود أسماء اللقاحات', true);
        } catch(err) {
            showToast('خطأ في قراءة الملف', false);
        }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
}

async function extractAndMergeVaccineRules() {
    if (!vrWorkbook) return showToast('يرجى تحميل ملف أولاً', false);
    var colNum = parseInt(document.getElementById('vr-col-select').value, 10);
    var ws = vrWorkbook.worksheets[0];
    var names = new Set();
    ws.eachRow({ includeEmpty: false }, function(row, rn) {
        if (rn === 1) return; // skip header
        var val = row.getCell(colNum).value;
        if (val) names.add(String(val).trim());
    });
    var added = 0;
    for (var name of names) {
        if (!name) continue;
        var existing = await db.vaccine_rules.get(name);
        if (!existing) {
            await db.vaccine_rules.put({ vaccine: name, dosesPerVial: 1, wastageAllowed: false, destroyedAllowed: false });
            added++;
        }
    }
    await refreshVaccineRulesFromDB();
    showToast('تم استخراج ' + names.size + ' طعم — أُضيف ' + added + ' جديد للجدول', true);
}

function renderCapacitiesTable() {
    const tbody = document.getElementById('capacities-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    if (vaccineCapacities.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" class="text-center text-zinc-500 py-4">لا توجد سعات مخصصة مسجلة حالياً.</td></tr>`;
        return;
    }
    
    vaccineCapacities.forEach(c => {
        const vName = c.vaccine.replace(/'/g, "\\'");
        tbody.innerHTML += `
            <tr>
                <td><strong>${c.vaccine}</strong></td>
                <td class="font-mono" style="color:var(--cyan)">${c.dosesPerVial} جرعة بالزجاجة</td>
                <td>
                    <div style="display:flex;gap:6px;justify-content:center">
                        <button onclick="editVaccineCapacity('${vName}', ${c.dosesPerVial})" class="btn btn-secondary btn-sm" title="تعديل" style="color:var(--cyan);border-color:rgba(34,211,238,0.3)">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        <button onclick="deleteVaccineCapacity('${vName}')" class="btn btn-secondary btn-sm" title="حذف" style="color:var(--rose);border-color:rgba(239,68,68,0.3)">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    });
}

async function addVaccineCapacity() {
    const nameInput = document.getElementById('cap-vaccine-name');
    const dosesInput = document.getElementById('cap-doses-count');
    
    const vaccine = nameInput.value.trim();
    const dosesPerVial = parseInt(dosesInput.value, 10);
    
    if (!vaccine || isNaN(dosesPerVial) || dosesPerVial < 1) {
        return showToast('يرجى إدخال اسم اللقاح وعدد جرعات صحيح (>= 1)', false);
    }
    
    await db.vaccine_capacities.put({ vaccine, dosesPerVial });
    await refreshCapacitiesFromDB();
    
    nameInput.value = '';
    dosesInput.value = '';
    showToast('تمت إضافة/تحديث سعة العبوة بنجاح', true);
}

async function deleteVaccineCapacity(vaccine) {
    showConfirmModal(
        'حذف سعة اللقاح',
        `هل ترغب في إزالة سعة العبوة المخصصة لطعم (${vaccine})؟`,
        async () => {
            await db.vaccine_capacities.delete(vaccine);
            await refreshCapacitiesFromDB();
            showToast('تم حذف سعة العبوة بنجاح', true);
        }
    );
}

// ==========================================================================
// VACCINE PACKAGES MANAGEMENT FUNCTIONS
// ==========================================================================
async function seedDefaultPackages() {
    const count = await db.vaccine_packages.count();
    if (count === 0) {
        const defaults = [
            { doseLevel: "صفرية", vaccines: "شلل أطفال سابين" },
            { doseLevel: "بى سى جى", vaccines: "بى سى جى" },
            { doseLevel: "الأولى", vaccines: "الخماسى، شلل أطفال سابين، شلل أطفال سولك" },
            { doseLevel: "الثانية", vaccines: "الخماسى، شلل أطفال سابين، شلل أطفال سولك" },
            { doseLevel: "الثالثة", vaccines: "الخماسى، شلل أطفال سابين، شلل أطفال سولك" },
            { doseLevel: "الرابعة", vaccines: "شلل أطفال سابين" },
            { doseLevel: "الخامسة", vaccines: "MMR، شلل أطفال سابين" },
            { doseLevel: "المنشطة", vaccines: "MMR، الثلاثى، شلل أطفال سابين" },
            { doseLevel: "جرعة الميلاد", vaccines: "كبدى B" }
        ];
        await db.vaccine_packages.bulkPut(defaults);
    }
}

async function refreshPackagesFromDB() {
    const list = await db.vaccine_packages.toArray();
    VACCINE_PACKAGES = {};
    list.forEach(item => {
        VACCINE_PACKAGES[item.doseLevel] = item.vaccines
            .split(/[،,]/)
            .map(v => v.trim())
            .filter(Boolean);
    });
    renderPackagesTable(list);
}

function renderPackagesTable(list) {
    const tbody = document.getElementById('packages-tbody');
    if (!tbody) return;  // tab not mounted yet, data is in memory
    tbody.innerHTML = '';

    list.forEach(function(p) {
        var dl = (p.doseLevel || '').replace(/\\/g, '\\\\').replace(/'/g, '&#39;');
        var vx = (p.vaccines || '').replace(/\\/g, '\\\\').replace(/'/g, '&#39;');
        tbody.innerHTML += '<tr>' +
            '<td><strong>' + p.doseLevel + '</strong></td>' +
            '<td class="text-slate-300 font-medium">' + p.vaccines + '</td>' +
            '<td><div style="display:flex;gap:6px;justify-content:center">' +
            '<button onclick="editVaccinePackage(&#39;' + dl + '&#39;, &#39;' + vx + '&#39;)" class="btn btn-secondary btn-sm" title="تعديل" style="color:var(--cyan);border-color:rgba(34,211,238,0.3)">' +
            '<i class="fa-solid fa-pen"></i></button>' +
            '</div></td></tr>';
    });
}

async function saveVaccinePackage() {
    const doseLevel = document.getElementById('pkg-dose-level').value;
    const vaccines  = document.getElementById('pkg-vaccine-name').value.trim();
    if (!vaccines) return showToast('يرجى كتابة اللقاحات المطلوبة مفصولة بفاصلة', false);
    await db.vaccine_packages.put({ doseLevel, vaccines });
    await refreshPackagesFromDB();
    showToast('تم تحديث باقة الجرعة بنجاح', true);
    document.getElementById('pkg-vaccine-name').value = '';
}

// ── Edit helpers: prefill the form fields for updating existing entries ───
function editVaccineCapacity(vaccine, dosesPerVial) {
    document.getElementById('cap-vaccine-name').value = vaccine;
    document.getElementById('cap-doses-count').value  = dosesPerVial;
    document.getElementById('cap-vaccine-name').focus();
    document.getElementById('cap-vaccine-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast(`تعديل: ${vaccine} — عدّل البيانات ثم اضغط "إضافة / تحديث"`, true);
}

function editVaccinePackage(doseLevel, vaccines) {
    const select = document.getElementById('pkg-dose-level');
    for (let opt of select.options) {
        if (opt.value === doseLevel) { select.value = doseLevel; break; }
    }
    document.getElementById('pkg-vaccine-name').value = vaccines;
    document.getElementById('pkg-vaccine-name').focus();
    document.getElementById('pkg-vaccine-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast(`تعديل: ${doseLevel} — عدّل اللقاحات ثم اضغط "حفظ باقة الجرعة"`, true);
}

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
    deferredPrompt = e;
});

function showInstallPrompt() {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(c => {
            if (c.outcome === 'accepted') showToast('شكرًا لتثبيتك التطبيق!', true);
            deferredPrompt = null;
        });
    } else {
        showToast('التطبيق مثبت بالفعل أو أن متصفحك لا يدعم التثبيت الفوري يدوياً.', false);
    }
}

function switchToIssues() {
    switchTab('stock-reviewer');
    filterStockTable('issue');
}

async function downloadStockTemplate() {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('نموذج الجرد المعتمد');
    worksheet.views = [{ rtl: true, showGridLines: true }];
    
    const headers = [
        'مكتب الصحة',
        'الطعم',
        'الرصيد المتبقي',
        'عدد المتطعمين',
        'الهادر',
        'المعدم',
        'رقم التشغيلة',
        'تاريخ الدخول',
        'تاريخ الانتهاء'
    ];
    worksheet.addRow(headers);
    
    worksheet.getRow(1).eachCell((cell) => {
        cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '10b981' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    
    worksheet.addRow(['بندر اهناسيا', 'MMR', 30, 150, 10, 0, '0164W049', '2026-07-01', '31 الجمعة , ديسمبر, 2027']);
    worksheet.addRow(['مكتب قاي', 'بى سى جى', 40, 200, 20, 0, '0164W050', '2026-07-02', '30 الثلاثاء , يونيو, 2028']);
    
    worksheet.columns.forEach(column => {
        column.width = 22;
    });
    
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'VaxGuard_Stock_Template.xlsx';
    link.click();
    showToast('تم تحميل نموذج شيت جرد اللقاحات بنجاح', true);
}

let stockTotals = [];

function calculateStockTotals() {
    const select = document.getElementById('totals-office-select');
    if (!select) return;
    select.innerHTML = '<option value="all">كافة المكاتب الصحية (الكل)</option>';
    
    const offices = Array.from(new Set(stockResults.map(r => r.office).filter(Boolean))).sort();
    offices.forEach(office => {
        select.innerHTML += `<option value="${office}">${office}</option>`;
    });
    
    updateTotalsTable();
}

function updateTotalsTable() {
    const select = document.getElementById('totals-office-select');
    if (!select) return;
    const selectedOffice = select.value;
    const tbody = document.getElementById('stock-totals-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    const records = selectedOffice === 'all' 
        ? stockResults 
        : stockResults.filter(r => r.office === selectedOffice);
        
    const totalsMap = new Map();
    records.forEach(r => {
        const vac = r.vaccine;
        if (!totalsMap.has(vac)) {
            totalsMap.set(vac, { remaining: 0, vaccinated: 0, wastage: 0, destroyed: 0 });
        }
        const t = totalsMap.get(vac);
        t.remaining += r.remaining;
        t.vaccinated += r.vaccinated;
        t.wastage += r.wastage;
        t.destroyed += r.destroyed;
    });
    
    stockTotals = [];
    if (totalsMap.size === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-zinc-500 py-6">لا توجد بيانات إجماليات لعرضها</td></tr>`;
        return;
    }
    
    totalsMap.forEach((t, vaccine) => {
        stockTotals.push({ vaccine, ...t });
        tbody.innerHTML += `
            <tr>
                <td><strong>${vaccine}</strong></td>
                <td class="font-mono font-semibold text-emerald-400">${t.remaining.toLocaleString()}</td>
                <td class="font-mono text-zinc-300">${t.vaccinated.toLocaleString()}</td>
                <td class="font-mono text-amber-300">${t.wastage.toLocaleString()}</td>
                <td class="font-mono text-rose-400">${t.destroyed.toLocaleString()}</td>
            </tr>
        `;
    });
}

async function exportTotalsExcel() {
    if (stockTotals.length === 0) {
        showToast('لا توجد بيانات إجماليات للتصدير', false);
        return;
    }
    const selectedOffice = document.getElementById('totals-office-select').value;
    const officeLabel = selectedOffice === 'all' ? 'كافة المكاتب' : selectedOffice;
    
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('إجماليات اللقاحات');
    worksheet.views = [{ rtl: true, showGridLines: true }];
    
    worksheet.mergeCells('A1:E1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = `تقرير إجماليات مخزون اللقاحات - مكتب: ${officeLabel}`;
    titleCell.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '7C3AED' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    worksheet.getRow(1).height = 40;
    
    const headers = ['اسم اللقاح / الطعم', 'إجمالي الرصيد المتبقي (جرعة)', 'إجمالي عدد المتطعمين', 'إجمالي الفاقد الهادر', 'إجمالي التالف المعدم'];
    worksheet.addRow(headers);
    
    worksheet.getRow(2).eachCell((cell) => {
        cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '4F46E5' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    
    stockTotals.forEach(t => {
        worksheet.addRow([t.vaccine, t.remaining, t.vaccinated, t.wastage, t.destroyed]);
    });
    
    const borderStyle = {
        top: { style: 'thin', color: { argb: 'E4E4E7' } },
        bottom: { style: 'thin', color: { argb: 'E4E4E7' } },
        left: { style: 'thin', color: { argb: 'E4E4E7' } },
        right: { style: 'thin', color: { argb: 'E4E4E7' } }
    };
    
    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber > 2) {
            row.eachCell(cell => {
                cell.alignment = { horizontal: 'center', vertical: 'middle' };
                cell.border = borderStyle;
            });
        }
    });
    
    worksheet.columns.forEach(column => { column.width = 25; });
    
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `VaxGuard_Totals_${officeLabel.replace(/\s+/g, '_')}.xlsx`;
    link.click();
    showToast('تم تصدير ملف إجماليات اللقاحات بنجاح', true);
}

function drawTableToCanvasAndDownload(title, headers, rows, filename) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    const colWidths = [200, 180, 180, 180, 180];
    const rowHeight = 45;
    const headerHeight = 60;
    const titleHeight = 80;
    
    const totalWidth = colWidths.reduce((a, b) => a + b, 0);
    const totalHeight = titleHeight + headerHeight + (rows.length * rowHeight) + 40;
    
    canvas.width = totalWidth;
    canvas.height = totalHeight;
    
    const bgGrad = ctx.createLinearGradient(0, 0, 0, totalHeight);
    bgGrad.addColorStop(0, '#090a10');
    bgGrad.addColorStop(1, '#0e111d');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, totalWidth, totalHeight);
    
    ctx.fillStyle = '#a78bfa';
    ctx.font = 'bold 24px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(title, totalWidth / 2, 45);
    
    ctx.fillStyle = '#64748b';
    ctx.font = '14px Arial, sans-serif';
    ctx.fillText('تطبيق VaxGuard Suite للتحقق والمطابقة والخدمات الإضافية', totalWidth / 2, 70);
    
    let currentY = titleHeight;
    ctx.fillStyle = '#1e1b4b';
    ctx.fillRect(0, currentY, totalWidth, headerHeight);
    ctx.strokeStyle = '#312e81';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, currentY, totalWidth, headerHeight);
    
    ctx.fillStyle = '#f4f4f5';
    ctx.font = 'bold 16px Arial, sans-serif';
    ctx.textAlign = 'center';
    
    let currentX = totalWidth;
    headers.forEach((header, idx) => {
        const w = colWidths[idx];
        currentX -= w;
        ctx.fillText(header, currentX + w / 2, currentY + 35);
    });
    
    ctx.font = '14px Arial, sans-serif';
    rows.forEach((row, rowIdx) => {
        currentY = titleHeight + headerHeight + (rowIdx * rowHeight);
        ctx.fillStyle = rowIdx % 2 === 0 ? 'rgba(255, 255, 255, 0.02)' : 'rgba(255, 255, 255, 0.00)';
        ctx.fillRect(0, currentY, totalWidth, rowHeight);
        
        ctx.beginPath();
        ctx.moveTo(0, currentY + rowHeight);
        ctx.lineTo(totalWidth, currentY + rowHeight);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.stroke();
        
        currentX = totalWidth;
        row.forEach((cellVal, idx) => {
            const w = colWidths[idx];
            currentX -= w;
            if (idx === 0) {
                ctx.fillStyle = '#e4e4e7';
                ctx.font = 'bold 14px Arial, sans-serif';
            } else if (idx === 1) {
                ctx.fillStyle = '#34d399';
                ctx.font = '14px Arial, sans-serif';
            } else {
                ctx.fillStyle = '#a1a1aa';
                ctx.font = '14px Arial, sans-serif';
            }
            ctx.fillText(String(cellVal), currentX + w / 2, currentY + 26);
        });
    });
    
    ctx.fillStyle = '#475569';
    ctx.font = '12px Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('مصمم بواسطة المهندس وائل سيد - VaxGuard Suite Engine', totalWidth - 20, totalHeight - 15);
    
    const link = document.createElement('a');
    link.download = filename;
    link.href = canvas.toDataURL('image/png');
    link.click();
}

function exportTotalsPNG() {
    if (stockTotals.length === 0) {
        showToast('لا توجد بيانات إجماليات للتصدير كصورة', false);
        return;
    }
    const selectedOffice = document.getElementById('totals-office-select').value;
    const officeLabel = selectedOffice === 'all' ? 'كافة المكاتب' : selectedOffice;
    const title = `كشف إجماليات مخزون اللقاحات - ${officeLabel}`;
    const headers = ['اللقاح / الطعم', 'إجمالي المتبقي (جرعة)', 'إجمالي المتطعمين', 'إجمالي الهادر', 'إجمالي التالف المعدم'];
    const rows = stockTotals.map(t => [
        t.vaccine,
        t.remaining.toLocaleString(),
        t.vaccinated.toLocaleString(),
        t.wastage.toLocaleString(),
        t.destroyed.toLocaleString()
    ]);
    drawTableToCanvasAndDownload(title, headers, rows, `VaxGuard_Totals_${officeLabel.replace(/\s+/g, '_')}.png`);
    showToast('تم تصدير كشف الإجماليات كصورة PNG بنجاح', true);
}

function exportResultsPNG() {
    const tbody = document.getElementById('stock-results-tbody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    if (rows.length === 0 || stockResults.length === 0) {
        showToast('لا توجد سجلات للتصدير كصورة', false);
        return;
    }
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    const colWidths = [60, 180, 140, 120, 110, 110, 240];
    const rowHeight = 45;
    const headerHeight = 60;
    const titleHeight = 80;
    
    const totalWidth = colWidths.reduce((a, b) => a + b, 0);
    const maxRenderRows = Math.min(rows.length, 30);
    const totalHeight = titleHeight + headerHeight + (maxRenderRows * rowHeight) + 40;
    
    canvas.width = totalWidth;
    canvas.height = totalHeight;
    
    const bgGrad = ctx.createLinearGradient(0, 0, 0, totalHeight);
    bgGrad.addColorStop(0, '#090a10');
    bgGrad.addColorStop(1, '#0e111d');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, totalWidth, totalHeight);
    
    ctx.fillStyle = '#a78bfa';
    ctx.font = 'bold 22px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('كشف نتائج فحص مخزون الوحدات والمكاتب الصحية', totalWidth / 2, 45);
    
    ctx.fillStyle = '#1e1b4b';
    ctx.fillRect(0, titleHeight, totalWidth, headerHeight);
    ctx.strokeStyle = '#312e81';
    ctx.strokeRect(0, titleHeight, totalWidth, headerHeight);
    
    const headers = ['الصف', 'مكتب الصحة', 'الطعم', 'رقم التشغيلة', 'الرصيد المتبقي', 'الحالة المكتشفة', 'تفاصيل المخالفات والملاحظات'];
    ctx.fillStyle = '#f4f4f5';
    ctx.font = 'bold 14px Arial, sans-serif';
    
    let currentY = titleHeight;
    let currentX = totalWidth;
    headers.forEach((h, idx) => {
        const w = colWidths[idx];
        currentX -= w;
        ctx.fillText(h, currentX + w / 2, currentY + 35);
    });
    
    ctx.font = '12px Arial, sans-serif';
    const filteredRowsData = [];
    for (let i = 0; i < maxRenderRows; i++) {
        const tr = rows[i];
        if (tr.cells.length < 7) continue;
        const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim().replace(/\s+/g, ' '));
        const isExpired = tr.classList.contains('row-expired');
        const hasIssues = tr.classList.contains('row-has-issues');
        filteredRowsData.push({ cells, isExpired, hasIssues });
    }
    
    filteredRowsData.forEach((row, rowIdx) => {
        currentY = titleHeight + headerHeight + (rowIdx * rowHeight);
        
        if (row.isExpired) {
            ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
        } else if (row.hasIssues) {
            ctx.fillStyle = 'rgba(245, 158, 11, 0.1)';
        } else {
            ctx.fillStyle = rowIdx % 2 === 0 ? 'rgba(255, 255, 255, 0.02)' : 'rgba(255, 255, 255, 0.00)';
        }
        ctx.fillRect(0, currentY, totalWidth, rowHeight);
        
        ctx.beginPath();
        ctx.moveTo(0, currentY + rowHeight);
        ctx.lineTo(totalWidth, currentY + rowHeight);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.stroke();
        
        currentX = totalWidth;
        row.cells.forEach((cellVal, idx) => {
            const w = colWidths[idx];
            currentX -= w;
            
            if (row.isExpired) {
                ctx.fillStyle = '#f87171';
            } else if (row.hasIssues) {
                ctx.fillStyle = '#fbbf24';
            } else {
                ctx.fillStyle = '#d1d5db';
            }
            
            if (idx === 0 || idx === 3 || idx === 4) {
                ctx.font = 'bold 12px Courier New, monospace';
            } else {
                ctx.font = '12px Arial, sans-serif';
            }
            
            let displayVal = cellVal;
            if (idx === 6 && cellVal.length > 35) {
                displayVal = cellVal.substring(0, 32) + '...';
            }
            ctx.fillText(displayVal, currentX + w / 2, currentY + 26);
        });
    });
    
    ctx.fillStyle = '#475569';
    ctx.font = '11px Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('مصمم بواسطة المهندس وائل سيد - VaxGuard Suite Engine', totalWidth - 20, totalHeight - 15);
    
    const link = document.createElement('a');
    link.download = `VaxGuard_Stock_Report.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    showToast('تم تصدير السجلات المحددة كصورة بنجاح', true);
}

// ==========================================================================
// UTILITIES: MISSING VACCINATIONS CHECKER
// Fully matches Checker.py — multi-file, 14-column output, Python dedup
// ==========================================================================
// VACCINE_PACKAGES is declared at the top of the file (globals section)

let missingVaccineRecords = [];
let _missingFilteredRecords = [];
let _pendingMissingFiles   = []; // FileList from input, queued before analysis

// ── Panel navigation ──────────────────────────────────────────────────────
function openUtility(utilityId) {
    document.getElementById('utilities-menu-grid').classList.add('hidden');
    document.getElementById('utility-workspace').classList.remove('hidden');
    document.querySelectorAll('.utility-subpanel').forEach(p => p.classList.add('hidden'));
    document.getElementById(`util-${utilityId}`).classList.remove('hidden');
}
function closeUtility() {
    document.getElementById('utility-workspace').classList.add('hidden');
    document.getElementById('utilities-menu-grid').classList.remove('hidden');
}

// ── Reset ─────────────────────────────────────────────────────────────────
function resetMissingChecker() {
    missingVaccineRecords     = [];
    _missingFilteredRecords   = [];
    _pendingMissingFiles      = [];

    const ids = ['missing-results-tbody','missing-stats-row','missing-file-items'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });

    ['missing-results-container','missing-processing','missing-files-list'].forEach(id => {
        document.getElementById(id)?.classList.add('hidden');
    });
    document.getElementById('missing-upload-zone')?.classList.remove('hidden');

    const si = document.getElementById('missing-search-input'); if (si) si.value = '';
    const df = document.getElementById('missing-dose-filter');  if (df) df.value = '';
    const fi = document.getElementById('missing-file-input');   if (fi) fi.value = '';
}

// -- Drag-and-drop
function handleMissingDrop(e) {
    e.preventDefault();
    document.getElementById('missing-drop-area')?.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.match(/\.xlsx?$/i));
    if (!files.length) return showToast('يجب ان تكون الملفات بصيغة .xlsx', false);
    _queueFiles(files);
}

function handleMissingUpload(e) {
    const files = Array.from(e.target.files || []).filter(f => f.name.match(/\.xlsx?$/i));
    if (!files.length) return;
    _queueFiles(files);
}

function _queueFiles(files) {
    files.forEach(f => {
        if (!_pendingMissingFiles.find(x => x.name === f.name && x.size === f.size)) {
            _pendingMissingFiles.push(f);
        }
    });
    _renderFilesList();
}

function _renderFilesList() {
    const listDiv  = document.getElementById('missing-files-list');
    const itemsDiv = document.getElementById('missing-file-items');
    const countEl  = document.getElementById('missing-files-count');
    const n = _pendingMissingFiles.length;

    if (!n) { listDiv.classList.add('hidden'); return; }
    listDiv.classList.remove('hidden');
    countEl.textContent = `${n} ${n === 1 ? 'ملف محدد' : 'ملفات محددة'}`;

    itemsDiv.innerHTML = _pendingMissingFiles.map((f, i) => `
        <div class="flex items-center gap-3 bg-slate-900/60 rounded-lg px-3 py-2 border border-slate-800">
            <i class="fa-solid fa-file-excel text-emerald-400 text-sm shrink-0"></i>
            <span class="text-xs text-slate-300 flex-1 truncate">${f.name}</span>
            <span class="text-xs text-slate-500">${(f.size/1024).toFixed(1)} KB</span>
            <button onclick="_removePendingFile(${i})" class="text-slate-500 hover:text-rose-400 transition-colors text-xs">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>`).join('');
}

function _removePendingFile(idx) {
    _pendingMissingFiles.splice(idx, 1);
    _renderFilesList();
    if (!_pendingMissingFiles.length) {
        document.getElementById('missing-files-list')?.classList.add('hidden');
    }
}

// ── Start analysis (called by "بدء التحليل" button) ──────────────────────
async function startMissingAnalysis() {
    if (!_pendingMissingFiles.length) return showToast('لا توجد ملفات لتحليلها', false);

    // Show spinner, hide upload zone
    document.getElementById('missing-upload-zone').classList.add('hidden');
    document.getElementById('missing-processing').classList.remove('hidden');
    document.getElementById('missing-results-container').classList.add('hidden');

    const statusEl = document.getElementById('missing-processing-status');
    const seenKeys = new Set();
    missingVaccineRecords = [];

    for (let fi = 0; fi < _pendingMissingFiles.length; fi++) {
        const file = _pendingMissingFiles[fi];
        if (statusEl) statusEl.textContent = `يعالج: ${file.name} (${fi+1} / ${_pendingMissingFiles.length})`;

        try {
            await _processMissingFile(file, seenKeys);
        } catch (err) {
            console.error(`[Missing Checker] Error in ${file.name}:`, err);
            showToast(`خطأ في ملف: ${file.name}`, false);
        }
    }

    console.log(`[Missing Checker] Done. Total flagged: ${missingVaccineRecords.length}`);
    document.getElementById('missing-processing').classList.add('hidden');
    renderMissingResults(_pendingMissingFiles);

    const msg = missingVaccineRecords.length === 0
        ? 'تم الفحص: لا توجد طعوم متأخرة أو ناقصة'
        : `اكتمل الفحص: ${missingVaccineRecords.length} سجل مكتشف من ${_pendingMissingFiles.length} ملف`;
    showToast(msg, missingVaccineRecords.length === 0);
}

// ── Process a single file ─────────────────────────────────────────────────
async function _processMissingFile(file, seenKeys) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async function(ev) {
            try {
                const data = new Uint8Array(ev.target.result);
                const workbook = new ExcelJS.Workbook();
                await workbook.xlsx.load(data);
                const sheet = workbook.worksheets[0];

                // Row 4 = headers (pandas skiprows=3)
                // Build TWO maps:
                //   headers[]       = col index → header name
                //   firstColByName  = header name → FIRST column index with that name
                //   secondColByName = header name → SECOND column index with that name (for duplicates)
                const headers       = [];   // 1-based: headers[col] = name
                const firstColByName  = {}; // name → first col idx
                const secondColByName = {}; // name → second col idx (duplicate headers)

                sheet.getRow(4).eachCell({ includeEmpty: true }, (cell, col) => {
                    const raw = getCellValuePrimitive(cell);
                    const name = raw ? _safeText(raw) : '';
                    headers[col] = name;
                    if (name) {
                        if (firstColByName[name] === undefined) {
                            firstColByName[name] = col;
                        } else if (secondColByName[name] === undefined) {
                            secondColByName[name] = col;
                        }
                    }
                });

                // Helper: get cell value by column index
                const cellVal = (row, col) => col ? _safeText(getCellValuePrimitive(row.getCell(col))) : '';

                // Column indices for the FIRST occurrence of each location header
                // (Python always uses the first المديرية group — col 7/8/11 in the real files)
                const regDirCol   = firstColByName['المديرية'];
                const regAdminCol = firstColByName['الادارة الصحية'];
                const regUnitCol  = firstColByName['الوحدة الصحية'];

                let currentChild    = null;
                let currentVaccines = [];

                for (let rNum = 5; rNum <= sheet.rowCount; rNum++) {
                    const row = sheet.getRow(rNum);

                    // Build name→value map (first-occurrence wins for duplicate names)
                    const rowData = {};
                    for (let c = 1; c < headers.length; c++) {
                        const hdr = headers[c];
                        if (hdr && rowData[hdr] === undefined) {
                            rowData[hdr] = getCellValuePrimitive(row.getCell(c));
                        }
                    }

                    const name    = _safeText(rowData['الاسم']);
                    const dose    = _safeText(rowData['الجرعة']);
                    const vaccine = _safeText(rowData['نوع الطعم']);

                    if (name) {
                        if (currentChild) _addMissingRecord(currentChild, currentVaccines, seenKeys);

                        // ── Exact Python port ──────────────────────────────────────────────
                        // Python's get_vaccination_location() reads المديرية (col 7) FIRST,
                        // then falls back to مكان التطعيم - المديرية only if col 7 is empty.
                        // Python's get_registration_location() ALWAYS reads col 7 group.
                        // In practice (confirmed by running original Python on the real files),
                        // both functions return identical values — they both use the first
                        // المديرية group (col 7/8/11). The second duplicate group (col 15/17)
                        // is never used by Python.
                        //
                        // We use cellVal(row, regDirCol) to access col 7 directly by index,
                        // avoiding the duplicate-header overwrite problem.

                        // Vaccination Location: second set of location columns (col ~15 group)
                        // The duplicate المديرية/الادارة/الوحدة columns hold vaccination location.
                        // secondColByName tracks them since firstColByName records only the first occurrence.
                        const vacDirCol2   = secondColByName[headers[regDirCol]];
                        const vacAdminCol2 = secondColByName[headers[regAdminCol]];
                        const vacUnitCol2  = secondColByName[headers[regUnitCol]];
                        // Primary: use second-group cols; fallback: use first-group (same area)
                        const vacDir   = cellVal(row, vacDirCol2)   || cellVal(row, regDirCol);
                        const vacAdmin = cellVal(row, vacAdminCol2) || cellVal(row, regAdminCol);
                        const vacUnit  = cellVal(row, vacUnitCol2)  || cellVal(row, regUnitCol);
                        const vacLoc   = [vacDir, vacAdmin, vacUnit].filter(Boolean).join(' - ');

                        // Registration Location: first set of location columns (col ~7 group)
                        const regLoc = [
                            cellVal(row, regDirCol),
                            cellVal(row, regAdminCol),
                            cellVal(row, regUnitCol)
                        ].filter(Boolean).join(' - ');


                        currentChild = {
                            serial:           _safeText(rowData['م']),
                            name,
                            birth_date:       formatExcelJSDate(rowData['تاريخ الميلاد']),
                            dose,
                            vaccination_date: formatExcelJSDate(rowData['تاريخ التطعيم']),
                            registration_date:formatExcelJSDate(rowData['تاريخ تسجيل علي الميكنة']),
                            reg_number:       _safeText(rowData['رقم القيد']),
                            nationality:      _safeText(rowData['الجنسية']),
                            gender:           _safeText(rowData['النوع']),
                            record_type:      _safeText(rowData['نوع القيد']),
                            vac_location:     vacLoc,
                            reg_location:     regLoc
                        };
                        currentVaccines = [];
                    }


                    if (vaccine) {
                        const c = cleanVaccineName(vaccine);
                        if (c) currentVaccines.push(c);
                    }
                }
                if (currentChild) _addMissingRecord(currentChild, currentVaccines, seenKeys);
                resolve();
            } catch (err) { reject(err); }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

// ── Core logic matching Python exactly ───────────────────────────────────
function _addMissingRecord(child, receivedVaccines, seenKeys) {
    const dose = child.dose;
    if (!dose || !VACCINE_PACKAGES[dose]) return;

    const required = VACCINE_PACKAGES[dose];
    const missing  = required.filter(v => !receivedVaccines.includes(v));
    if (!missing.length) return;

    // Dedup key = Python's drop_duplicates(subset=[Serial, Child Name, Dose, Missing Vaccines])
    const dedupKey = `${child.serial}||${child.name}||${dose}||${missing.join(', ')}`;
    if (seenKeys.has(dedupKey)) return;
    seenKeys.add(dedupKey);

    missingVaccineRecords.push({
        // ── Exact Python column order ──────────────────────────────────
        Serial:               child.serial,
        'Child Name':         child.name,
        'Birth Date':         child.birth_date,
        Dose:                 dose,
        'Missing Vaccines':   missing.join(', '),          // Python uses ', ' not '، '
        'Received Vaccines':  receivedVaccines.join(', ') || '',
        'Vaccination Location':    child.vac_location || '',
        'Registration Location':   child.reg_location || '',
        'Registration Number':     child.reg_number   || '',
        'Vaccination Date':        child.vaccination_date  || '',
        'Registration Date':       child.registration_date || '',
        Nationality:          child.nationality || '',
        Gender:               child.gender      || '',
        'Record Type':        child.record_type  || '',
        // ── Internal helpers (not exported) ───────────────────────────
        _missingList:         missing,   // raw array for stats
    });
}

// ── Helper string functions ───────────────────────────────────────────────
function _safeText(val) {
    if (val === null || val === undefined) return '';
    if (val instanceof Date) return val.toISOString().split('T')[0];
    if (typeof val === 'object' && val.text) return val.text.toString().trim();
    if (typeof val === 'object' && val.richText) return val.richText.map(r => r.text).join('').trim();
    return val.toString().trim();
}

function cleanVaccineName(vaccine) {
    if (!vaccine) return '';
    return vaccine.toString().trim().replace(/"/g, '').replace(/[\n\r]/g, '').trim();
}

function formatExcelJSDate(val) {
    if (!val) return '';
    if (val instanceof Date) return val.toISOString().split('T')[0];
    if (typeof val === 'object') {
        if (val.result instanceof Date) return val.result.toISOString().split('T')[0];
        const p = getCellValuePrimitive(val);
        if (p instanceof Date) return p.toISOString().split('T')[0];
        val = p;
    }
    const s = String(val).trim();
    if (!s) return '';
    // Handle "2024-10-06 07:05 PM" style strings (same as Python)
    if (s.includes('AM') || s.includes('PM')) {
        const parts = s.replace(/ (AM|PM)$/, '').trim().split(' ');
        return parts[0] || s;
    }
    if (s.includes('T')) return s.split('T')[0];
    return s.split(' ')[0];
}

// ── Render results ────────────────────────────────────────────────────────
function renderMissingResults(files) {
    _missingFilteredRecords = [...missingVaccineRecords];

    // Source bar
    const sourceText = document.getElementById('missing-source-text');
    if (sourceText && files) {
        const names = files.map(f => f.name).join(' • ');
        sourceText.textContent = `تم تحليل ${files.length} ملف: ${names}`;
    }

    _renderMissingStatsCards();
    _renderMissingTable(_missingFilteredRecords);

    document.getElementById('missing-upload-zone').classList.add('hidden');
    document.getElementById('missing-results-container').classList.remove('hidden');
}

function _renderMissingStatsCards() {
    const total = missingVaccineRecords.length;

    const byDose = {};
    missingVaccineRecords.forEach(r => { byDose[r.Dose] = (byDose[r.Dose] || 0) + 1; });
    const topDose = Object.entries(byDose).sort((a,b) => b[1]-a[1])[0];

    const uniqueLocs = new Set(missingVaccineRecords.map(r => r['Vaccination Location']).filter(Boolean)).size;

    const vc = {};
    missingVaccineRecords.forEach(r => r._missingList.forEach(v => { vc[v] = (vc[v]||0)+1; }));
    const topVac = Object.entries(vc).sort((a,b) => b[1]-a[1])[0];

    document.getElementById('missing-stats-row').innerHTML = `
        <div class="kpi-card border-rose rounded-2xl p-4 border border-rose-500/25">
            <div class="text-xs text-slate-400 mb-1">إجمالي المتأخرين</div>
            <div class="text-2xl font-bold text-rose-400 font-mono">${total}</div>
            <div class="text-xs text-slate-500 mt-1">سجل مكتشف</div>
        </div>
        <div class="kpi-card border-amber rounded-2xl p-4 border border-amber-500/25">
            <div class="text-xs text-slate-400 mb-1">أكثر جرعة بمشاكل</div>
            <div class="text-base font-bold text-amber-400 truncate">${topDose ? topDose[0] : '—'}</div>
            <div class="text-xs text-slate-500 mt-1">${topDose ? topDose[1]+' حالة' : ''}</div>
        </div>
        <div class="kpi-card border-violet rounded-2xl p-4 border border-violet-500/25">
            <div class="text-xs text-slate-400 mb-1">مواقع متأثرة</div>
            <div class="text-2xl font-bold text-violet-400 font-mono">${uniqueLocs}</div>
            <div class="text-xs text-slate-500 mt-1">موقع / وحدة</div>
        </div>
        <div class="kpi-card border-emerald rounded-2xl p-4 border border-emerald-500/25">
            <div class="text-xs text-slate-400 mb-1">أكثر طعم ناقص</div>
            <div class="text-sm font-bold text-emerald-400 truncate">${topVac ? topVac[0] : '—'}</div>
            <div class="text-xs text-slate-500 mt-1">${topVac ? topVac[1]+' طفل' : ''}</div>
        </div>`;
}

function _renderMissingTable(records) {
    const tbody   = document.getElementById('missing-results-tbody');
    const summary = document.getElementById('missing-summary-text');
    const counter = document.getElementById('missing-row-count');

    if (!records.length) {
        tbody.innerHTML = missingVaccineRecords.length === 0
            ? `<tr><td colspan="14" class="p-10 text-center">
                <div class="flex flex-col items-center gap-3">
                    <i class="fa-solid fa-circle-check text-emerald-400 text-4xl"></i>
                    <p class="text-white font-semibold">لا توجد طعوم متأخرة أو ناقصة</p>
                    <p class="text-slate-500 text-xs">جميع الأطفال مستوفون لجرعاتهم المقررة</p>
                </div></td></tr>`
            : `<tr><td colspan="14" class="p-6 text-center text-slate-500 text-xs">لا توجد نتائج مطابقة لمعايير البحث</td></tr>`;
        if (summary) summary.textContent = '';
        if (counter) counter.textContent = '';
        return;
    }

    if (summary) summary.textContent = `${missingVaccineRecords.length} طفل لم يستكمل طعومه المقررة.`;
    if (counter) counter.textContent  = records.length < missingVaccineRecords.length
        ? `عرض ${records.length} من ${missingVaccineRecords.length}` : `${records.length} سجل`;

    const frag = document.createDocumentFragment();
    records.forEach((r, idx) => {
        const tr = document.createElement('tr');
        tr.className = 'border-b border-slate-900/60 hover:bg-violet-500/5 transition-colors';
        tr.innerHTML = `
            <td class="p-3 text-center text-slate-500 font-mono text-xs">${r.Serial || idx+1}</td>
            <td class="p-3 font-semibold text-white text-xs whitespace-nowrap">${r['Child Name']}</td>
            <td class="p-3 text-slate-400 text-xs whitespace-nowrap">${r['Birth Date'] || '—'}</td>
            <td class="p-3 text-center"><span class="badge badge-indigo text-xs whitespace-nowrap">${r.Dose}</span></td>
            <td class="p-3 text-rose-400 font-semibold text-xs">${r['Missing Vaccines']}</td>
            <td class="p-3 text-slate-400 text-xs">${r['Received Vaccines'] || '—'}</td>
            <td class="p-3 text-slate-300 text-xs">${r['Vaccination Location'] || '—'}</td>
            <td class="p-3 text-slate-400 text-xs">${r['Registration Location'] || '—'}</td>
            <td class="p-3 text-center text-slate-400 font-mono text-xs">${r['Registration Number'] || '—'}</td>
            <td class="p-3 text-center text-slate-400 text-xs whitespace-nowrap">${r['Vaccination Date'] || '—'}</td>
            <td class="p-3 text-center text-slate-400 text-xs whitespace-nowrap">${r['Registration Date'] || '—'}</td>
            <td class="p-3 text-center text-slate-400 text-xs">${r.Nationality || '—'}</td>
            <td class="p-3 text-center text-slate-400 text-xs">${r.Gender || '—'}</td>
            <td class="p-3 text-center text-slate-400 text-xs">${r['Record Type'] || '—'}</td>
        `;
        frag.appendChild(tr);
    });
    tbody.innerHTML = '';
    tbody.appendChild(frag);
}

// ── Filter ────────────────────────────────────────────────────────────────
function filterMissingResults() {
    const term = (document.getElementById('missing-search-input')?.value || '').toLowerCase().trim();
    const dose = document.getElementById('missing-dose-filter')?.value || '';

    _missingFilteredRecords = missingVaccineRecords.filter(r => {
        const matchDose = !dose || r.Dose === dose;
        const matchTerm = !term ||
            (r['Child Name'] || '').toLowerCase().includes(term) ||
            (r['Vaccination Location'] || '').toLowerCase().includes(term) ||
            (r['Registration Number'] || '').toLowerCase().includes(term) ||
            (r['Missing Vaccines'] || '').toLowerCase().includes(term);
        return matchDose && matchTerm;
    });
    _renderMissingTable(_missingFilteredRecords);
}

// ── Excel Export — EXACTLY matching Python's save_to_master output ────────
// Python: plain DataFrame → sheet "Missing Doses" → file "Missing Doses.xlsx"
// Same 14 column names, same column order, no styling (plain, like pandas output)
async function exportMissingExcel() {
    const data = _missingFilteredRecords.length > 0 ? _missingFilteredRecords : missingVaccineRecords;
    if (!data.length) { showToast('لا توجد سجلات لتصديرها', false); return; }

    try {
        const workbook = new ExcelJS.Workbook();
        const sheet    = workbook.addWorksheet('Missing Doses'); // Exact Python sheet name

        // Exactly the 14 Python column names in exact order
        const PYTHON_COLS = [
            'Serial', 'Child Name', 'Birth Date', 'Dose',
            'Missing Vaccines', 'Received Vaccines',
            'Vaccination Location', 'Registration Location',
            'Registration Number', 'Vaccination Date', 'Registration Date',
            'Nationality', 'Gender', 'Record Type'
        ];

        // Header row — plain bold, mimicking pandas default openpyxl output
        const headerRow = sheet.addRow(PYTHON_COLS);
        headerRow.font = { bold: true };

        // Data rows — plain, exactly like pandas dataframe_to_rows
        data.forEach(r => {
            sheet.addRow(PYTHON_COLS.map(col => {
                const v = r[col];
                if (col === 'Serial' && v && !isNaN(v)) return parseInt(v);
                return v || '';
            }));
        });

        // Auto column widths (same character-based logic as pandas auto)
        sheet.columns.forEach((col, i) => {
            let max = PYTHON_COLS[i].length;
            col.eachCell({ includeEmpty: false }, cell => {
                const len = cell.value ? String(cell.value).length : 0;
                if (len > max) max = len;
            });
            col.width = Math.min(max + 2, 60);
        });

        const buffer = await workbook.xlsx.writeBuffer();
        const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const a      = document.createElement('a');
        a.href       = URL.createObjectURL(blob);
        a.download   = 'Missing Doses.xlsx'; // Exact Python filename
        a.click();
        showToast('تم تصدير Missing Doses.xlsx بنجاح', true);
    } catch (err) {
        console.error(err);
        showToast('فشل التصدير', false);
    }
}

// ── PNG Export ────────────────────────────────────────────────────────────
function exportMissingPNG() {
    const data = _missingFilteredRecords.length > 0 ? _missingFilteredRecords : missingVaccineRecords;
    if (!data.length) { showToast('لا توجد سجلات للتصدير', false); return; }

    const maxRows = Math.min(data.length, 40);
    const cols = [
        { key: 'Serial',             label: 'م',               w: 44  },
        { key: 'Child Name',         label: 'اسم الطفل',       w: 160 },
        { key: 'Dose',               label: 'الجرعة',          w: 80  },
        { key: 'Missing Vaccines',   label: 'الطعوم الناقصة',  w: 200 },
        { key: 'Received Vaccines',  label: 'الطعوم المتلقاة', w: 180 },
        { key: 'Vaccination Location',label: 'مكان التطعيم',  w: 170 },
        { key: 'Birth Date',         label: 'تاريخ الميلاد',   w: 90  },
        { key: 'Registration Number',label: 'رقم القيد',       w: 80  },
    ];
    const totalW = cols.reduce((a, c) => a + c.w, 0);
    const rowH = 36, headerH = 48, titleH = 72;
    const canvas = document.createElement('canvas');
    canvas.width  = totalW;
    canvas.height = titleH + headerH + maxRows * rowH + 36;
    const ctx = canvas.getContext('2d');

    // BG gradient
    const bg = ctx.createLinearGradient(0, 0, 0, canvas.height);
    bg.addColorStop(0, '#090a10'); bg.addColorStop(1, '#0d1020');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Title
    ctx.fillStyle = '#f43f5e'; ctx.font = 'bold 18px Arial'; ctx.textAlign = 'center';
    ctx.fillText('كشف الأطفال المتأخرين والناقصين عن تطعيماتهم', canvas.width/2, 36);
    ctx.fillStyle = '#64748b'; ctx.font = '11px Arial';
    ctx.fillText(`VaxGuard Suite  •  ${new Date().toLocaleDateString('ar-EG')}  •  ${data.length} سجل`, canvas.width/2, 58);

    // Header
    ctx.fillStyle = '#1e1b4b'; ctx.fillRect(0, titleH, canvas.width, headerH);
    ctx.strokeStyle = '#4c1d95'; ctx.lineWidth = 1;
    ctx.strokeRect(0, titleH, canvas.width, headerH);
    ctx.fillStyle = '#e2e8f0'; ctx.font = 'bold 11px Arial';
    let cx = canvas.width;
    cols.forEach(col => {
        cx -= col.w;
        ctx.textAlign = 'center';
        ctx.fillText(col.label, cx + col.w/2, titleH + 28);
    });

    // Rows
    for (let i = 0; i < maxRows; i++) {
        const r = data[i];
        const y = titleH + headerH + i * rowH;
        ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0)';
        ctx.fillRect(0, y, canvas.width, rowH);
        ctx.beginPath(); ctx.moveTo(0, y+rowH); ctx.lineTo(canvas.width, y+rowH);
        ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 0.5; ctx.stroke();

        cx = canvas.width;
        cols.forEach((col, ci) => {
            cx -= col.w;
            let val = String(r[col.key] || '—');
            if (val.length > Math.floor(col.w/7)) val = val.slice(0, Math.floor(col.w/7)-1)+'…';
            ctx.fillStyle = ci === 3 ? '#f87171' : ci === 1 ? '#ffffff' : '#94a3b8';
            ctx.font = ci === 1 ? 'bold 10px Arial' : '10px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(val, cx + col.w/2, y + 22);
        });
    }
    if (data.length > maxRows) {
        ctx.fillStyle = '#64748b'; ctx.font = '10px Arial'; ctx.textAlign = 'center';
        ctx.fillText(`... و ${data.length - maxRows} سجل إضافي — قم بتصدير إكسيل للاطلاع على الكامل`, canvas.width/2, canvas.height - 18);
    }

    // Watermark
    ctx.fillStyle = '#334155'; ctx.font = '9px Arial'; ctx.textAlign = 'right';
    ctx.fillText('VaxGuard Suite — المهندس وائل سيد', canvas.width - 16, canvas.height - 6);

    const a = document.createElement('a');
    a.download = `Missing_Doses_${new Date().toISOString().split('T')[0]}.png`;
    a.href     = canvas.toDataURL('image/png');
    a.click();
    showToast('تم تصدير الصورة بنجاح', true);
}


/* ==========================================================================
   BILINGUAL TRANSLATION & THEME SWITCH ENGINE
   ========================================================================== */
function t(key) {
    const lang = settings.language || 'ar';
    if (I18N[lang] && I18N[lang][key]) {
        return I18N[lang][key];
    }
    return key;
}

function getTranslatedRuleLabels() {
    const lang = settings.language || 'ar';
    return {
        'expiry': { 
            title: lang === 'ar' ? 'تاريخ انتهاء الصلاحية والجرعات' : 'Expiry Date & Doses Validation', 
            desc: lang === 'ar' ? 'تنبيه عند قرب انتهاء تاريخ صلاحية اللقاحات المتبقية' : 'Alert when the remaining vaccine batches are near expiry'
        },
        'vial_capacity_match': { 
            title: lang === 'ar' ? 'مطابقة سعة عبوات اللقاحات' : 'Vial Doses Capacity Match', 
            desc: lang === 'ar' ? 'تحقق من صحة الجرعات المستلمة والمستهلكة وفقاً لسعة عبوة كل طعم' : 'Validate received/consumed doses based on the specific doses-per-vial capacity of each vaccine'
        },
        'wastage_bounds': { 
            title: lang === 'ar' ? 'حدود الهادر والتالف المقررة' : 'Wastage & Damage Bounds', 
            desc: lang === 'ar' ? 'تجاوز حدود الهادر/التالف المسموح للجرعات والمتبقي' : 'Flag records exceeding typical wastage or destroyed margins'
        },
        'zero_usage_mismatch': { 
            title: lang === 'ar' ? 'مخالفة الصرف الصفري' : 'Wastage with Zero Usage', 
            desc: lang === 'ar' ? 'تسجيل استهلاك/هادر بدون وجود متطعمين فعلياً بالوحدة' : 'Flag records showing consumed/wasted vaccines with zero actual vaccinations registered'
        },
        'excessive_stock': { 
            title: lang === 'ar' ? 'مؤشر التخزين الزائد' : 'Excessive Stock Limit', 
            desc: lang === 'ar' ? 'تجاوز رصيد اللقاح المتبقي للحد الأقصى المسموح به مقارنة بمتوسط استهلاكه' : 'Flag remaining stock exceeding the allowed maximum storage compared to average monthly consumption'
        },
        'duplicate_entries': { 
            title: lang === 'ar' ? 'تكرار إدخال البيانات' : 'Duplicate Entries Check', 
            desc: lang === 'ar' ? 'تنبيه في حال تكرار نفس البيانات تحت تاريخ الدخول والتشغيلة للمكتب' : 'Flag identical stock entries registered for the same office under the same entry date'
        }
    };
}

function applyLanguage() {
    const lang = settings.language || 'ar';
    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    
    // Update toggle button text
    const btnSpan = document.getElementById('lang-toggle-btn').querySelector('span');
    if (btnSpan) btnSpan.textContent = (lang === 'ar') ? 'EN' : 'AR';
    
    // Translate static UI elements
    translateStaticUI();
    
    // Rerender all components with translated dynamic values
    renderAveragesTable();
    renderNameTiesTable();
    renderBatchDBTable();
    renderHistoryLogList();
    renderRulesControlUI();
    populateExceptionsDropdowns();
    
    if (currentTab) {
        switchTab(currentTab);
    }
}

function toggleLanguage() {
    settings.language = (settings.language === 'ar') ? 'en' : 'ar';
    saveSettings();
    applyLanguage();
    showToast(settings.language === 'ar' ? 'تم تغيير اللغة بنجاح' : 'Language updated successfully', true);
}

function translateStaticUI() {
    const lang = settings.language || 'ar';
    const t = (key) => I18N[lang][key] || key;
    
    // Sidebar nav labels
    const navs = {
        'nav-dashboard': 'nav_dashboard',
        'nav-stock-reviewer': 'nav_stock_reviewer',
        'nav-monthly-averages': 'nav_averages',
        'nav-name-ties': 'nav_ties',
        'nav-batch-verifier': 'nav_batch_verifier',
        'nav-batch-db': 'nav_batch_db',
        'nav-history': 'nav_history',
        'nav-utilities': 'nav_utilities',
        'nav-settings': 'nav_settings',
        'nav-user-guide': 'nav_guide',
        'nav-about': 'nav_about'
    };
    
    for (const [id, key] of Object.entries(navs)) {
        const el = document.getElementById(id);
        if (el) {
            const labelEl = el.querySelector('.nav-label');
            if (labelEl) labelEl.textContent = t(key);
        }
    }
    
    // Table Header Translation Dictionary
    const tableHeaderTranslations = {
        'مكتب الصحة': 'col_office',
        'الطعم': 'col_vaccine',
        'اللقاح': 'col_vaccine',
        'نوع الطعم': 'col_vaccine',
        'الطعم / اللقاح': 'col_vaccine',
        'رقم التشغيلة': 'col_batch',
        'التشغيلة': 'col_batch',
        'تاريخ الانتهاء': 'col_expiry',
        'المتبقي': 'col_remaining',
        'الرصيد المتبقي': 'col_remaining',
        'مستوى الخطورة': 'col_threat_level',
        'الأيام المتبقية': 'col_days_left',
        'الشركة المنتجة': 'col_manufacturer',
        'ملاحظات': 'col_notes',
        'اسم الطفل': 'col_child_name',
        'الرقم المسلسل': 'col_serial',
        'الجرعة المستهدفة': 'col_target_dose',
        'التطعيمات الناقصة': 'col_missing_vaccines',
        'العملية': 'col_action',
        'التاريخ': 'col_date',
        'الصف': 'col_row',
        'الحالة المكتشفة': 'col_status',
        'المخالفات والملاحظات': 'col_notes',
        'إجمالي الرصيد المتبقي (جرعة)': 'col_total_remaining_doses',
        'إجمالي عدد المتطعمين': 'col_total_vaccinated',
        'إجمالي الفاقد الهادر': 'col_total_wasted',
        'إجمالي التالف المعدم': 'col_total_damaged',
        'متوسط الاستهلاك الشهري (جرعة)': 'col_monthly_avg_doses',
        'الحد الأقصى المسموح به (جرعة)': 'col_max_stock_doses',
        'الإجراءات': 'col_actions',
        'النوع': 'col_type',
        'الاسم الأصلي (في الإكسيل)': 'col_original_name',
        'الاسم المستهدف (في النظام)': 'col_approved_name',
        'نتيجة المطابقة': 'col_match_result',
        'رقم التشغيلة بالملف': 'col_file_batch',
        'نوع اللقاح بالملف': 'col_file_vaccine',
        'تاريخ الانتهاء بالملف': 'col_file_expiry',
        'التفاصيل والملاحظات': 'col_details_notes',
        'رقم التشغيلة المعتمد': 'col_approved_batch',
        'نوع اللقاح المعتمد': 'col_approved_vaccine',
        'الشركة المصنعة': 'col_manufacturer',
        'تاريخ انتهاء الصلاحية المعتمد': 'col_approved_expiry',
        'ملاحظات الدعم الفني': 'col_tech_notes',
        'القاعدة المستثناة': 'col_excluded_rule',
        'حذف': 'col_delete',
        'سعة العبوة (جرعة بالزجاجة)': 'col_vial_capacity',
        'مستوى الجرعة': 'col_dose_level',
        'اللقاحات والطعوم الإلزامية المطلوبة بالباقة': 'col_mandated_vaccines',
        'م': 'col_index',
        'الجرعة': 'col_dose_round',
        'الطعوم المتأخرة والناقصة': 'col_overdue_vaccines',
        'الطعوم التي تلقاها': 'col_received_vaccines',
        'مكان التطعيم': 'col_location',
        'تاريخ الميلاد': 'col_dob',
        'رقم القيد': 'col_record_no'
    };
    
    document.querySelectorAll('th').forEach(th => {
        const txt = th.textContent.trim();
        if (tableHeaderTranslations[txt]) {
            th.textContent = t(tableHeaderTranslations[txt]);
        } else {
            const inverseKey = Object.entries(I18N.en).find(([k, v]) => v === txt)?.[0];
            if (inverseKey) {
                const arWord = Object.keys(tableHeaderTranslations).find(k => tableHeaderTranslations[k] === inverseKey);
                if (arWord) th.textContent = arWord;
            }
        }
    });

    // Content headers, labels, and charts translations
    const textTranslations = {
        'توزيع اللقاحات المتبقية حسب الطعم والنوع': 'chart_stock_levels',
        'مستويات تخزين اللقاحات بالجرعة': 'chart_stock_levels',
        'مؤشر المخالفات والمخاطر المكتشفة': 'chart_issues_distribution',
        'توزيع ونسب المخالفات المكتشفة': 'chart_issues_distribution',
        'اللقاحات الأقرب لانتهاء الصلاحية بالمخزون': 'expiry_urgency',
        'المكاتب ذات المشاكل': 'stat_issues',
        'الوحدات والمكاتب المشمولة': 'stat_offices',
        'إجمالي جرعات اللقاحات': 'stat_doses',
        'التشغيلات المعتمدة بالدليل': 'stat_batches',
        'الرصيد المتبقي (جرعات)': 'col_total_remaining',
        'لا تتوفر لقاحات بتاريخ صلاحية موثق حالياً.': 'empty_expiry',
        'قم برفع ملف مخزون لعرض البيانات التحليلية.': 'empty_upload'
    };
    
    document.querySelectorAll('h3, h4, span, label').forEach(el => {
        const txt = el.textContent.trim();
        if (textTranslations[txt]) {
            el.textContent = t(textTranslations[txt]);
        } else {
            const inverseKey = Object.entries(I18N.en).find(([k, v]) => v === txt)?.[0];
            if (inverseKey) {
                const arWord = Object.keys(textTranslations).find(k => textTranslations[k] === inverseKey);
                if (arWord) el.textContent = arWord;
            }
        }
    });

    // Translate other major elements
    const selectors = [
        ['.brand-subtitle', 'app_subtitle'],
        ['.footer-status .status-text', 'indexeddb_active'],
        ['.btn-install-pwa', 'install_app'],
        ['#expiry-urgency-title', 'expiry_urgency'],
        ['#stock-upload-title', 'upload_stock_title'],
        ['#stock-upload-desc', 'upload_stock_desc'],
        ['#btn-browse-stock', 'btn_browse_excel'],
        ['#stock-template-desc', 'template_desc'],
        ['#btn-download-template', 'btn_download_template'],
        ['#btn-filter-stock-all', 'filter_all'],
        ['#btn-filter-stock-clean', 'filter_clean'],
        ['#btn-filter-stock-issue', 'filter_issue'],
        ['#btn-export-stock-xlsx', 'export_xlsx'],
        ['#btn-export-stock-png', 'export_png'],
        ['#btn-check-another-stock', 'btn_check_another'],
        ['#btn-add-avg-manual', 'btn_add_avg_manual'],
        ['#btn-import-consumption', 'btn_import_consumption'],
        ['#btn-undo-averages', 'btn_undo'],
        ['#tie-category-label', 'tie_cat_label'],
        ['#tie-source-label', 'tie_src_label'],
        ['#tie-target-label', 'tie_target_label'],
        ['#btn-create-tie', 'btn_create_tie'],
        ['#btn-clear-all-ties', 'btn_clear_all_ties'],
        ['#batch-upload-title', 'nav_batch_verifier'],
        ['#batch-upload-desc', 'batch_verifier_desc'],
        ['#btn-browse-batch', 'btn_browse_excel'],
        ['#btn-filter-batch-all', 'filter_all'],
        ['#btn-filter-batch-valid', 'filter_valid'],
        ['#btn-filter-batch-mismatch', 'filter_mismatch'],
        ['#btn-filter-batch-invalid', 'filter_invalid'],
        ['#btn-export-batch-xlsx', 'export_xlsx'],
        ['#btn-export-batch-png', 'export_png'],
        ['#btn-check-another-batch', 'btn_check_another'],
        ['#add-batch-title', 'add_batch_title'],
        ['#btn-save-batch', 'btn_save_batch'],
        ['#btn-wipe-batches-db', 'btn_wipe_batches_db'],
        ['#missing-checker-title', 'missing_checker_title'],
        ['#missing-checker-desc', 'missing_checker_desc'],
        ['#btn-launch-utility', 'btn_launch_utility'],
        ['#btn-close-utility', 'btn_close_utility'],
        ['#btn-browse-missing', 'btn_browse_excel'],
        ['#btn-export-missing-xlsx', 'export_xlsx'],
        ['#btn-export-missing-png', 'export_png'],
        ['#btn-check-another-missing', 'btn_check_another'],
        ['#settings-header', 'settings_title'],
        ['#ref-date-label', 'ref_date_lbl'],
        ['#option-current-date-lbl', 'option_current_date'],
        ['#option-custom-date-lbl', 'option_custom_date'],
        ['#excessive-factor-lbl', 'excessive_factor_lbl'],
        ['#rules-config-title', 'rules_config_title'],
        ['#rules-config-desc', 'rules_config_desc'],
        ['#exceptions-title', 'exceptions_title'],
        ['#exceptions-desc', 'exceptions_desc'],
        ['#btn-add-exception', 'btn_add_exception'],
        ['#capacities-title', 'capacities_title'],
        ['#capacities-desc', 'capacities_desc'],
        ['#btn-save-capacity', 'btn_save_capacity'],
        ['#packages-title', 'packages_title'],
        ['#packages-desc', 'packages_desc'],
        ['#btn-save-package', 'btn_save_package'],
        ['#backups-title', 'backups_title'],
        ['#backups-desc', 'backups_desc'],
        ['#btn-export-backup', 'btn_export_backup'],
        ['#btn-import-backup', 'btn_import_backup'],
        ['#dev-name-lbl', 'dev_name'],
        ['#dev-title-lbl', 'dev_title'],
        ['#dev-bio-lbl', 'dev_bio'],
        ['#chart-doses-dist-title', 'chart_doses_dist_title'],
        ['#chart-issues-radar-title', 'chart_issues_radar_title']
    ];
    
    for (const [selector, key] of selectors) {
        const el = document.querySelector(selector);
        if (el) el.textContent = t(key);
    }
    
    // Input placeholders
    const placeholders = [
        ['#stock-search-input', 'search_stock_placeholder'],
        ['#avg-search-input', 'search_avg_placeholder'],
        ['#ties-search-input', 'search_ties_placeholder'],
        ['#batch-search-input', 'search_batches_db_placeholder'],
        ['#batch-db-search', 'search_batches_db_placeholder'],
        ['#tie-source-input', 'tie_src_label'],
        ['#tie-target-input', 'tie_target_label']
    ];
    
    for (const [selector, key] of placeholders) {
        const el = document.querySelector(selector);
        if (el) el.placeholder = t(key);
    }
    
    // User Guide Content
    renderUserGuideUI();
}

function renderUserGuideUI() {
    const container = document.getElementById('user-guide-content');
    if (!container) return;
    
    const arGuide = `
        <h3 class="guide-title">كتيب إرشادات تشغيل منظومة VaxGuard Suite</h3>
        <p class="guide-subtitle">دليل المساعد التقني لتشغيل خوارزميات المراجعة والربط التلقائي لقاعدة بيانات اللقاحات وسجلات الأطفال:</p>
        
        <div class="guide-list">
            <div class="glass-card">
                <h4 class="guide-sec-emerald">1. فحص مخزون الوحدات ومطابقته</h4>
                <p class="guide-text">
                    قم برفع شيت جرد مخازن الطعوم الشهري في تبويب (فحص مخزون الوحدات). ستعمل الخوارزميات على فحص التواريخ والكميات المتبقية ومطابقتها بمعدل الاستهلاك الشهري المسجل لكل وحدة.
                </p>
            </div>
            <div class="glass-card">
                <h4 class="guide-sec-amber">2. التحقق من أرقام التشغيلات</h4>
                <p class="guide-text">
                    قارن التشغيلات المسجلة في شيت الجرد مع دليل التشغيلات الوزارية المعتمد بقاعدة البيانات. سيقوم النظام بالإشارة إلى أية تشغيلات غير مطابقة لتواريخ الصلاحية أو غير مسجلة لتأمين السلامة العامة.
                </p>
            </div>
            <div class="glass-card">
                <h4 class="guide-sec-rose">3. فحص تطعيمات الأطفال الناقصة</h4>
                <p class="guide-text">
                    في قسم (الخدمات المساعدة)، اختر فاحص التطعيمات المتأخرة للأطفال وارفع شيت جرد الأطفال. سيقوم المعالج بتجميع جرعات الأطفال تلقائياً وإصدار كشوف المتأخرين بالاسم والمستهدف.
                </p>
            </div>
        </div>
    `;
    
    const enGuide = `
        <h3 class="guide-title">Operator Manual for VaxGuard Suite</h3>
        <p class="guide-subtitle">Technical guide for operating review algorithms and automated record reconciliation:</p>
        
        <div class="guide-list">
            <div class="glass-card">
                <h4 class="guide-sec-emerald">1. Unit Stock Reconciliation & Review</h4>
                <p class="guide-text">
                    Upload the monthly vaccine stock ledger in the (Unit Stock Reviewer) tab. Algorithms will analyze expiry dates and remaining volumes against each unit's registered monthly consumption average.
                </p>
            </div>
            <div class="glass-card">
                <h4 class="guide-sec-amber">2. Batch Number Verification</h4>
                <p class="guide-text">
                    Compare registered batch numbers against the approved guide in your local database. The system flags expiry date discrepancies or unlisted batches to ensure vaccine safety.
                </p>
            </div>
            <div class="glass-card">
                <h4 class="guide-sec-rose">3. Overdue Children Immunization Audit</h4>
                <p class="guide-text">
                    In the (Utilities) section, launch the overdue child checker and upload the child record ledger. The system aggregates received doses and lists child names with overdue vaccines.
                </p>
            </div>
        </div>
    `;
    
    container.innerHTML = (settings.language === 'ar') ? arGuide : enGuide;
}

const I18N = {
    ar: {
        col_row: "الصف",
        col_status: "الحالة المكتشفة",
        col_total_remaining_doses: "إجمالي الرصيد المتبقي (جرعة)",
        col_total_vaccinated: "إجمالي عدد المتطعمين",
        col_total_wasted: "إجمالي الفاقد الهادر",
        col_total_damaged: "إجمالي التالف المعدم",
        col_monthly_avg_doses: "متوسط الاستهلاك الشهري (جرعة)",
        col_max_stock_doses: "الحد الأقصى المسموح به (جرعة)",
        col_actions: "الإجراءات",
        col_type: "النوع",
        col_original_name: "الاسم الأصلي (في الإكسيل)",
        col_approved_name: "الاسم المستهدف (في النظام)",
        col_match_result: "نتيجة المطابقة",
        col_file_batch: "رقم التشغيلة بالملف",
        col_file_vaccine: "نوع اللقاح بالملف",
        col_file_expiry: "تاريخ الانتهاء بالملف",
        col_details_notes: "التفاصيل والملاحظات",
        col_approved_batch: "رقم التشغيلة المعتمد",
        col_approved_vaccine: "نوع اللقاح المعتمد",
        col_approved_expiry: "تاريخ انتهاء الصلاحية المعتمد",
        col_tech_notes: "ملاحظات الدعم الفني",
        col_excluded_rule: "القاعدة المستثناة",
        col_delete: "حذف",
        col_vial_capacity: "سعة العبوة (جرعة بالزجاجة)",
        col_dose_level: "مستوى الجرعة",
        col_mandated_vaccines: "اللقاحات والطعوم الإلزامية المطلوبة بالباقة",
        col_index: "م",
        col_dose_round: "الجرعة",
        col_overdue_vaccines: "الطعوم المتأخرة والناقصة",
        col_received_vaccines: "الطعوم التي تلقاها",
        col_location: "مكان التطعيم",
        col_dob: "تاريخ الميلاد",
        col_record_no: "رقم القيد",
                col_office: "مكتب الصحة",
        col_vaccine: "الطعم / اللقاح",
        col_batch: "التشغيلة",
        col_expiry: "تاريخ الانتهاء",
        col_remaining: "الرصيد المتبقي",
        col_threat_level: "مستوى الخطورة",
        col_days_left: "الأيام المتبقية",
        col_manufacturer: "الشركة المنتجة",
        col_notes: "ملاحظات",
        col_child_name: "اسم الطفل",
        col_serial: "الرقم المسلسل",
        col_target_dose: "الجرعة المستهدفة",
        col_missing_vaccines: "التطعميات الناقصة",
        col_action: "العملية",
        col_date: "التاريخ",
        col_total_remaining: "الرصيد المتبقي (جرعات)",
        empty_expiry: "لا تتوفر لقاحات بتاريخ صلاحية موثق حالياً.",
        empty_upload: "قم برفع ملف مخزون لعرض البيانات التحليلية.",
        empty_reports: "لا تتوفر تقارير مخزنة حالياً بسجلاتك المحلية.",
                rule_expiry: "صلاحية منتهية",
        rule_vial_capacity_match: "سعة العبوات",
        rule_wastage_bounds: "الهادر والتلف",
        rule_excessive_stock: "تخزين زائد",
        search_stock_placeholder: "ابحث باسم مكتب الصحة أو الطعم...",
                app_title: "VaxGuard Suite",
        app_subtitle: "المنظومة المتكاملة للقاحات",
        nav_dashboard: "لوحة التحكم والتحليل",
        nav_stock_reviewer: "فحص مخزون الوحدات",
        nav_averages: "حدود معدل الاستهلاك",
        nav_ties: "روابط مطابقة الأسماء",
        nav_batch_verifier: "التحقق من التشغيلات",
        nav_batch_db: "قاعدة التشغيلات المعتمدة",
        nav_history: "سجل الفحوصات والتقارير",
        nav_utilities: "الخدمات والأدوات الإضافية",
        nav_settings: "إعدادات الفحص والنظام",
        nav_guide: "دليل المستخدم المساعد",
        nav_about: "حول المطور",
        toggle_theme: "تغيير المظهر",
        install_app: "تثبيت التطبيق",
        dashboard_desc: "إحصائيات تفاعلية وتحليلات لسلامة مخازن اللقاحات",
        active_warnings: "تنبيهات نشطة",
        user_name: "وائل سيد",
        stat_offices: "الوحدات والمكاتب المشمولة",
        stat_doses: "إجمالي جرعات اللقاحات",
        stat_batches: "التشغيلات المعتمدة بالدليل",
        stat_issues: "المكاتب ذات المشاكل",
        click_details: "انقر لعرض السجلات التفصيلية",
        chart_stock_levels: "مستويات تخزين اللقاحات بالجرعة",
        chart_issues_distribution: "توزيع ونسب المخالفات المكتشفة",
        chart_doses_dist_title: "توزيع اللقاحات المتبقية حسب الطعم والنوع",
        chart_issues_radar_title: "مؤشر المخالفات والمخاطر المكتشفة",
        expiry_urgency: "اللقاحات الأقرب لانتهاء الصلاحية",
        col_office: "مكتب الصحة",
        col_vaccine: "الطعم / اللقاح",
        col_batch: "التشغيلة",
        col_expiry: "تاريخ الانتهاء",
        col_remaining: "الرصيد المتبقي",
        col_days_left: "الأيام المتبقية",
        upload_stock_title: "تحميل ملف فحص ومراجعة المخزون",
        upload_stock_desc: "اختر شيت إكسيل لتتبع مخزون طعوم الوحدات الصحية والمكاتب ومطابقته",
        btn_browse_excel: "تصفح ملفات الجهاز (.xlsx)",
        template_desc: "تأكد من مطابقة أعمدة ملفك أو تحميل الشيت القياسي المعتمد:",
        btn_download_template: "تحميل نموذج شيت الجرد القياسي",
        filter_all: "الكل",
        filter_clean: "سجلات سليمة",
        filter_issue: "سجلات بها مشاكل",
        export_xlsx: "تصدير كشيت إكسيل",
        export_png: "تصدير كصورة PNG",
        btn_check_another: "فحص ملف آخر",
        totals_summary_title: "كشوف إجماليات اللقاحات والطعوم",
        label_office_filter: "تصفية حسب المكتب الصحي:",
        export_totals_xlsx: "تصدير الإجماليات (XLSX)",
        export_totals_png: "تصدير الإجماليات (PNG)",
        btn_add_avg_manual: "إضافة استهلاك يدوي",
        btn_import_consumption: "استيراد شيت الاستهلاك",
        btn_undo: "تراجع عن آخر استيراد",
        btn_create_tie: "إنشاء رابط الاسم",
        btn_clear_all_ties: "حذف كافة روابط الأسماء",
        search_stock_placeholder: "ابحث برقم التشغيلة أو اللقاح...",
        search_avg_placeholder: "ابحث باسم مكتب الصحة أو الطعم...",
        search_ties_placeholder: "ابحث في الروابط المسجلة...",
        search_batches_db_placeholder: "ابحث برقم التشغيلة أو اللقاح...",
        tie_cat_label: "فئة المسمى المرتبط",
        tie_src_label: "الاسم الأصلي الوارد بالملف",
        tie_target_label: "الاسم المعتمد بالنظام",
        batch_verifier_desc: "اختر شيت إكسيل للتحقق من أرقام التشغيلات المسجلة ومطابقتها مع الدليل",
        filter_valid: "تشغيلات مطابقة",
        filter_mismatch: "مخالفة لبيانات الدليل",
        filter_invalid: "تشغيلات غير مسجلة بالدليل",
        add_batch_title: "إضافة / تحديث بيانات تشغيلة لقاح معتمدة",
        btn_save_batch: "حفظ التشغيلة بقاعدة البيانات",
        btn_wipe_batches_db: "مسح كامل قاعدة البيانات",
        audit_log_title: "سجل العمليات والتقارير المفحوصة سابقاً",
        missing_checker_title: "فاحص التطعيمات المتأخرة للأطفال",
        missing_checker_desc: "مراجعة ملف جرد لقاحات وتطعيمات الأطفال والتحقق من اكتمال الطعوم المقررة لكل جرعة والوقوف على أي تأخيرات.",
        btn_launch_utility: "تشغيل أداة الفحص",
        btn_close_utility: "إغلاق الأداة",
        ref_date_lbl: "مرجع تقييم صلاحية تاريخ انتهاء الصلاحية",
        option_current_date: "تاريخ الكمبيوتر الحالي (تلقائي اليوم)",
        option_custom_date: "تحديد تاريخ مرجعي مخصص للفحص",
        excessive_factor_lbl: "حد مؤشر تخزين اللقاحات الزائد بالمكتب",
        rules_config_title: "إدارة قواعد الفحص ومطابقة الشروط",
        rules_config_desc: "قم بتفعيل أو تعطيل قواعد الفحص المطبقة على المخزون بشكل منفصل:",
        exceptions_title: "استثناءات الوحدات الصحية (Bypass Exceptions)",
        exceptions_desc: "بإمكانك تعيين استثناءات لمنع تطبيق قاعدة معينة على طعم لقاح محدد في مكتب صحي بعينه:",
        btn_add_exception: "إضافة استثناء",
        capacities_title: "إدارة سعات عبوات اللقاحات (Vial Capacities)",
        capacities_desc: "إدارة عدد الجرعات لكل عبوة لكل طعم لقاح لتأمين مطابقة العبوات وتأكيد صحتها:",
        btn_save_capacity: "إضافة / تحديث السعة",
        packages_title: "إدارة باقات وجرعات التطعيمات الإلزامية للأطفال",
        packages_desc: "قم بتعديل قائمة الطعوم الإلزامية المطلوبة لكل جرعة (مثل الأولى أو المنشطة) لتخصيص فحص التطعيمات المتأخرة:",
        btn_save_package: "حفظ باقة الجرعة",
        backups_title: "النسخ الاحتياطي للنظام",
        backups_desc: "قم بتصدير قاعدة البيانات بالكامل (التشغيلات المعتمدة ومعدلات الاستهلاك وسجلات الفحص) لاستيرادها احتياطياً:",
        btn_export_backup: "تصدير حزمة النسخ الاحتياطي (.json)",
        btn_import_backup: "استيراد حزمة النسخ الاحتياطي (.json)",
        dev_name: "وائل سيد",
        dev_title: "مطور برمجيات ومهتم بلغات التطوير",
        dev_bio: "مرحباً! أنا وائل، مطور برمجيات شغوف ومحب للغات البرمجة والتحليل الإحصائي. قمت بتطوير منظومة VaxGuard Suite لتأمين ومطابقة أرصدة اللقاحات ومراجعة جداول تطعيمات الأطفال لمساعدة الوحدات ومكاتب الصحة العامة على تأدية مهامهم بكفاءة ودقة عالية.",
        indexeddb_active: "IndexedDB نشط (موفّر للطاقة)",
        stat_total: "إجمالي السجلات"
    },
    en: {
        col_row: "Row",
        col_status: "Detected Issue",
        col_total_remaining_doses: "Total Remaining (Doses)",
        col_total_vaccinated: "Total Vaccinated",
        col_total_wasted: "Total Wasted",
        col_total_damaged: "Total Damaged",
        col_monthly_avg_doses: "Monthly Average (Doses)",
        col_max_stock_doses: "Max Allowed Stock (Doses)",
        col_actions: "Actions",
        col_type: "Type",
        col_original_name: "Original Name (Excel)",
        col_approved_name: "Approved Name (System)",
        col_match_result: "Match Result",
        col_file_batch: "File Batch No",
        col_file_vaccine: "File Vaccine Type",
        col_file_expiry: "File Expiry Date",
        col_details_notes: "Details & Notes",
        col_approved_batch: "Approved Batch No",
        col_approved_vaccine: "Approved Vaccine Type",
        col_approved_expiry: "Approved Expiry Date",
        col_tech_notes: "Technical Notes",
        col_excluded_rule: "Excluded Rule",
        col_delete: "Delete",
        col_vial_capacity: "Vial Capacity (Doses)",
        col_dose_level: "Dose Level",
        col_mandated_vaccines: "Mandated Vaccines Package",
        col_index: "No",
        col_dose_round: "Dose Round",
        col_overdue_vaccines: "Overdue/Missing Vaccines",
        col_received_vaccines: "Received Vaccines",
        col_location: "Location",
        col_dob: "Date of Birth",
        col_record_no: "Record No",
                col_office: "Health Office",
        col_vaccine: "Vaccine / Antigen",
        col_batch: "Batch Number",
        col_expiry: "Expiry Date",
        col_remaining: "Remaining Stock",
        col_threat_level: "Threat Level",
        col_days_left: "Days Left",
        col_manufacturer: "Manufacturer",
        col_notes: "Notes",
        col_child_name: "Child Name",
        col_serial: "Serial No",
        col_target_dose: "Target Round",
        col_missing_vaccines: "Overdue/Missing Vaccines",
        col_action: "Action",
        col_date: "Date",
        col_total_remaining: "Remaining Stock (Doses)",
        empty_expiry: "No vaccines with documented expiry currently available.",
        empty_upload: "Upload a stock file to view analytical data.",
        empty_reports: "No stored reports currently available in your local logs.",
                rule_expiry: "Expired Batches",
        rule_vial_capacity_match: "Vial Doses mismatch",
        rule_wastage_bounds: "Wastage & Damage",
        rule_excessive_stock: "Excessive Stock",
        search_stock_placeholder: "Search by health office or vaccine...",
                app_title: "VaxGuard Suite",
        app_subtitle: "Integrated Vaccine Suite",
        nav_dashboard: "Dashboard & Analytics",
        nav_stock_reviewer: "Unit Stock Reviewer",
        nav_averages: "Consumption Averages",
        nav_ties: "Name Spelling Ties",
        nav_batch_verifier: "Batch Safety Verifier",
        nav_batch_db: "Approved Batches DB",
        nav_history: "Audit & History Log",
        nav_utilities: "Utilities & Services",
        nav_settings: "System Settings",
        nav_guide: "Interactive Operator Guide",
        nav_about: "About Developer",
        toggle_theme: "Toggle Theme",
        install_app: "Install App",
        dashboard_desc: "Interactive statistics and safety analysis for vaccine storage",
        active_warnings: "Active Warnings",
        user_name: "Wael Sayed",
        stat_offices: "Covered Health Offices",
        stat_doses: "Total Vaccine Doses",
        stat_batches: "Approved Guide Batches",
        stat_issues: "Offices with Issues",
        click_details: "Click to view detailed records",
        chart_stock_levels: "Vaccine Storage Levels (Doses)",
        chart_issues_distribution: "Distribution of Detected Issues",
        chart_doses_dist_title: "Remaining Vaccine Distribution by Type",
        chart_issues_radar_title: "Detected Violations & Risks Index",
        expiry_urgency: "Vaccines Nearest to Expiry",
        col_office: "Health Office",
        col_vaccine: "Vaccine / Antigen",
        col_batch: "Batch Number",
        col_expiry: "Expiry Date",
        col_remaining: "Remaining Stock",
        col_days_left: "Days Left",
        upload_stock_title: "Upload Unit Stock Ledger File",
        upload_stock_desc: "Choose an Excel sheet to trace and validate vaccine stock levels",
        btn_browse_excel: "Browse Local Files (.xlsx)",
        template_desc: "Ensure your columns match or download the standard ledger template:",
        btn_download_template: "Download Standard Ledger Template",
        filter_all: "All Records",
        filter_clean: "Valid Records",
        filter_issue: "Flagged Records",
        export_xlsx: "Export to Excel (XLSX)",
        export_png: "Export Graphic Card (PNG)",
        btn_check_another: "Analyze Another File",
        totals_summary_title: "Summary of Vaccine Totals & Aggregations",
        label_office_filter: "Filter by Health Office:",
        export_totals_xlsx: "Export Totals (XLSX)",
        export_totals_png: "Export Totals Graphic (PNG)",
        btn_add_avg_manual: "Add Consumption Manually",
        btn_import_consumption: "Import Consumption Sheet",
        btn_undo: "Undo Last Import",
        btn_create_tie: "Create Spelling Tie",
        btn_clear_all_ties: "Delete All Spelling Ties",
        search_stock_placeholder: "Search by batch number or vaccine...",
        search_avg_placeholder: "Search by health office or vaccine...",
        search_ties_placeholder: "Search spelling ties...",
        search_batches_db_placeholder: "Search approved batches...",
        tie_cat_label: "Spelling Category",
        tie_src_label: "Original Name in File",
        tie_target_label: "Approved System Name",
        batch_verifier_desc: "Upload stock ledger to verify batch numbers against approved guides",
        filter_valid: "Valid Batches",
        filter_mismatch: "Data Discrepancy",
        filter_invalid: "Unlisted Batches",
        add_batch_title: "Add / Update Approved Guide Batch",
        btn_save_batch: "Save Batch to Database",
        btn_wipe_batches_db: "Wipe Batches Database",
        audit_log_title: "Historical Review Log & Archive",
        missing_checker_title: "Children Overdue Vaccinations Checker",
        missing_checker_desc: "Audit child vaccination ledgers and check for overdue doses against immunization schedules.",
        btn_launch_utility: "Launch Checker Utility",
        btn_close_utility: "Close Utility",
        ref_date_lbl: "Reference Date for Expiry Evaluation",
        option_current_date: "Current Computer Live Date (Today)",
        option_custom_date: "Specify Custom Reference Expiry Date",
        excessive_factor_lbl: "Excessive Stock Margin Threshold",
        rules_config_title: "Audit Rules & Discrepancies Toggles",
        rules_config_desc: "Toggle individual audit checks on or off for stock evaluation:",
        exceptions_title: "Health Office Bypass Exceptions",
        exceptions_desc: "Define specific rule exceptions for individual health offices and vaccines:",
        btn_add_exception: "Add Exception Bypass",
        capacities_title: "Vaccine Vial Doses Manager",
        capacities_desc: "Manage doses-per-vial rules for vaccine package verification checks:",
        btn_save_capacity: "Add / Update Capacity",
        packages_title: "Immunization Dose Rounds Packages",
        packages_desc: "Customize mandated vaccines list for each dose level (e.g. birth, 1st, 2nd) to check missing vaccines:",
        btn_save_package: "Save Package Round",
        backups_title: "System Backups & Recovery",
        backups_desc: "Export/Import all data configs, approved batches, consumption rates, and name links in JSON:",
        btn_export_backup: "Export Full Backup Package (.json)",
        btn_import_backup: "Import Full Backup Package (.json)",
        dev_name: "Wael Sayed",
        dev_title: "Software Developer & Language Analyst",
        dev_bio: "Hello! I am Wael, a software developer passionate about program languages and data review. I developed the VaxGuard Suite to secure and reconcile vaccine inventories and child immunization calendars, empowering public health units with high operational accuracy.",
        indexeddb_active: "IndexedDB Active (Power-saving mode)",
        stat_total: "Total Records"
    }
};

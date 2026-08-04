/* ============================================================
   Fuel Station Management System — Application Logic
   Vanilla JS. All data now lives in MySQL via the Express API
   (see api.js) — LocalStorage is used ONLY by api.js to hold the
   JWT auth token, nowhere else in this file.
   ============================================================ */

(function () {
  "use strict";

  /* ============ CONSTANTS ============ */
  // Fallback display values used only until /api/settings has loaded.
  const DEFAULT_OFFICE_NAME = "City Office — Vehicle Fuel Desk";
  const DEFAULT_CURRENCY = "৳";

  const IMG_MAX_WIDTH = 900;
  const IMG_QUALITY = 0.72;
  const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // client-side pre-check; server enforces its own limit too

  /* ============ STATE ============ */
  let records = [];          // full record list, as returned by GET /api/records
  let drivers = [];          // plain name strings, e.g. ["Driver 1", "Driver 2"]
  let fuelTypes = [];
  let stations = [];
  // name -> numeric id, needed only to call DELETE /api/<resource>/:id
  let driverIds = {};
  let fuelTypeIds = {};
  let stationIds = {};

  let officeName = DEFAULT_OFFICE_NAME;
  let logoPath = null;       // server-relative path (e.g. "/uploads/logo/x.png"), or null
  let currencySymbol = DEFAULT_CURRENCY;
  let brandingSettings = {};

  let currentUser = null;    // { id, username, fullName, role } once logged in
  let currentPage = "dashboard";
  let editingId = null;      // record code (e.g. "FS-0001") currently open in the form for edit
  let pendingSignRecordId = null;
  let dataRefreshInterval = null; // periodic background refresh — see refreshRecordsQuietly()
  let pendingConfirmAction = null;
  let sigPad = { canvas: null, ctx: null, drawing: false, hasInk: false };

  /* ============ UTILITIES ============ */
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.from(document.querySelectorAll(sel)); }
  function byId(id) { return document.getElementById(id); }

  // Delays calling `fn` until `delay`ms after the last call — used on the
  // search inputs so typing doesn't re-render the whole table per keystroke.
  function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  function escapeHtml(str) {
    if (str === undefined || str === null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatMoney(n) {
    const num = Number(n) || 0;
    return currencySymbol + num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatDateDisplay(dateStr) {
    if (!dateStr) return "-";
    let d;
    if (typeof dateStr === "string" && dateStr.includes("T")) {
      d = new Date(dateStr);
    } else if (typeof dateStr === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      d = new Date(dateStr + "T00:00:00");
    } else {
      d = new Date(dateStr);
    }
    if (isNaN(d)) return dateStr;
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  }

  // Returns today's date as "YYYY-MM-DD" in the browser's LOCAL timezone.
  function todayISO() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function formatTimestamp(ts) {
    if (!ts) return "-";
    const d = new Date(ts);
    if (isNaN(d)) return "-";
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");
    const seconds = String(d.getSeconds()).padStart(2, "0");
    return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
  }

  /* ============ TOASTS ============ */
  function showToast(message, type = "primary", icon = "circle-check") {
    const container = byId("toastContainer");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="fa-solid fa-${icon}"></i><span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add("leaving");
      setTimeout(() => toast.remove(), 260);
    }, 3200);
  }

  /* ============ LOADING OVERLAY ============ */
  function showLoading(label) {
    byId("loadingLabel").textContent = label || "Processing...";
    byId("loadingOverlay").classList.remove("hidden");
  }
  function hideLoading() { byId("loadingOverlay").classList.add("hidden"); }

  // Central place every API-driven action funnels through: shows the
  // overlay, awaits the (async) task, and — this is new now that every
  // action is a real network call — catches any failure (network error,
  // expired token, server validation error) and turns it into a toast
  // instead of a silent/uncaught rejection.
  async function runWithLoading(task, label) {
    showLoading(label);
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the spinner paint first
    try {
      await task();
    } catch (err) {
      handleApiError(err);
    } finally {
      hideLoading();
    }
  }

  // Shared handler for any rejected api.* call. A 401 means the token is
  // missing/expired — that's not "an error to show and move on from", it
  // means the session is over, so we bounce back to the login screen.
  function handleApiError(err) {
    if (err && err.status === 401) {
      showToast("Your session has expired — please log in again.", "danger", "right-from-bracket");
      forceLogout();
      return;
    }
    showToast((err && err.message) || "Something went wrong. Please try again.", "danger", "triangle-exclamation");
  }

  /* ============================================================
     AUTH / LOGIN
     ============================================================ */
  function initAuth() {
    const loginForm = byId("loginForm");
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = byId("loginUsername").value.trim();
      const password = byId("loginPassword").value;
      const errEl = byId("loginError");
      errEl.textContent = "";

      if (!username || !password) {
        errEl.textContent = "Username and password are required.";
        return;
      }

      const submitBtn = loginForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const res = await api.login(username, password);
        api.setAuthToken(res.token);
        currentUser = res.user;
        byId("loginPassword").value = "";
        await enterApp();
      } catch (err) {
        errEl.textContent = err.message || "Invalid username or password.";
      } finally {
        submitBtn.disabled = false;
      }
    });

    byId("logoutBtn").addEventListener("click", async () => {
      await api.logout();
      forceLogout();
    });

    // Resume an existing session on page load if a token is already stored.
    (async function tryResumeSession() {
      if (!api.getAuthToken()) return;
      try {
        const res = await api.me();
        currentUser = res.user;
        await enterApp();
      } catch (err) {
        api.setAuthToken(null); // stale/expired token — start fresh at the login screen
      }
    })();
  }

  // Hard reset back to the login screen — used both for a normal logout
  // click and for a 401 (expired/invalid token) caught anywhere in the app.
  function forceLogout() {
    api.setAuthToken(null);
    currentUser = null;
    if (dataRefreshInterval) { clearInterval(dataRefreshInterval); dataRefreshInterval = null; }
    stopNotifPolling();
    byId("appShell").classList.add("hidden");
    byId("loginScreen").classList.remove("hidden");
    byId("loginPassword").value = "";
    document.title = "Login | ATMABISWAS Fuel";
  }

  async function enterApp() {
    byId("loginScreen").classList.add("hidden");
    byId("appShell").classList.remove("hidden");
    applyRoleVisibility();
    // Always land on the Dashboard on a fresh login — without this, logging
    // in as a different user in the same tab (after Logout) would leave
    // whichever page/data the PREVIOUS user last viewed still on screen
    // (e.g. their Profile form's stale values) until manually navigated away.
    goToPage("dashboard");
    await runWithLoading(async () => {
      await loadAllData();
      refreshEverything();
    }, "Loading your data...");

    // Keep Dashboard/Records from silently going stale during a long session
    // (an office tab left open all day while other people submit/approve
    // requests) — only polls while the tab is actually visible, so a
    // minimized/background browser doesn't keep making requests for nothing.
    if (dataRefreshInterval) clearInterval(dataRefreshInterval);
    dataRefreshInterval = setInterval(() => {
      if (document.visibilityState === "visible") refreshRecordsQuietly();
    }, 60000);

    // Start notification polling (every 20s)
    startNotifPolling();
  }

  // Records nav/page label + subtitle change per role, since the same
  // "records" page now shows a different scoped slice of data depending on
  // who's logged in (backend-enforced — see recordModel.getAll(scope)).
  const RECORDS_PAGE_TEXT = {
    admin: { nav: "All Requests", title: "All Fuel Requests", subtitle: "Search, filter, approve and manage requests" },
    sir: { nav: "All Requests", title: "All Fuel Requests", subtitle: "Review, approve, and manage fuel requests" },
    driver: { nav: "My Fuel Requests", title: "My Fuel Requests", subtitle: "Fuel requests you have submitted" },
  };

  // Shows/hides every element marked data-role-admin, shows/hides whole
  // sidebar nav sections per data-nav-role, relabels the shared "records"
  // page/nav for the current role, and updates the topbar user chip — the
  // UI-side half of role-based permissions (the API itself is the real
  // enforcement boundary; this just avoids showing controls/pages a
  // non-admin would get a 403 from anyway, per the "strict page visibility,
  // not just button-hiding" requirement).
  function applyRoleVisibility() {
    if (!currentUser) return;
    const role = currentUser.role;
    const isAdmin = role === "admin";
    $all("[data-role-admin]").forEach((el) => el.classList.toggle("hidden", !isAdmin));

    $all(".nav-link[data-nav-role]").forEach((link) => {
      const allowed = link.dataset.navRole.split(",").includes(role);
      link.classList.toggle("hidden", !allowed);
    });

    // Same idea for individual dashboard stat cards — each role sees a
    // different, small set of numbers rather than one big shared grid.
    $all("[data-dash-role]").forEach((el) => {
      const allowed = el.dataset.dashRole.split(",").includes(role);
      el.classList.toggle("hidden", !allowed);
    });

    const text = RECORDS_PAGE_TEXT[role] || RECORDS_PAGE_TEXT.admin;
    byId("navRecordsLabel").textContent = text.nav;
    byId("recordsPageTitle").textContent = text.title;
    byId("recordsPageSubtitle").textContent = text.subtitle;
    PAGE_LABELS.records = text.nav;

    // If the user is currently sitting on a page their role no longer has
    // access to (can happen right after a role's nav changes), bounce them
    // to the Dashboard instead of leaving them on a blank/forbidden page.
    const activeLink = document.querySelector(`.nav-link[data-page="${currentPage}"]`);
    if (activeLink && activeLink.classList.contains("hidden")) goToPage("dashboard");

    byId("loggedUserLabel").textContent = currentUser.fullName || currentUser.username;
    if (currentUser.profilePhoto) {
      byId("userAvatar").innerHTML = `<img src="${currentUser.profilePhoto}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" />`;
    } else {
      byId("userAvatar").textContent = (currentUser.fullName || currentUser.username).charAt(0).toUpperCase();
    }
    byId("userAvatar").title = role.charAt(0).toUpperCase() + role.slice(1);
  }

  /* ============================================================
     NAVIGATION
     ============================================================ */
  function initNavigation() {
    $all(".nav-link[data-page]").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        goToPage(link.dataset.page);
      });
    });
    $all("a[data-page]").forEach((link) => {
      if (link.classList.contains("nav-link")) return;
      link.addEventListener("click", (e) => {
        e.preventDefault();
        goToPage(link.dataset.page);
      });
    });

    byId("sidebarToggle").addEventListener("click", () => {
      byId("sidebar").classList.add("open");
      byId("sidebarOverlay").classList.add("show");
    });
    byId("sidebarClose").addEventListener("click", closeSidebar);
    byId("sidebarOverlay").addEventListener("click", closeSidebar);
  }

  function closeSidebar() {
    byId("sidebar").classList.remove("open");
    byId("sidebarOverlay").classList.remove("show");
  }

  const PAGE_LABELS = {
    dashboard: "Dashboard",
    add: "Add Fuel Request",
    records: "All Requests",
    reports: "Reports",
    settings: "Settings",
    users: "User Management",
    profile: "My Profile",
  };

  function goToPage(page) {
    currentPage = page;
    $all(".page").forEach((p) => p.classList.remove("active"));
    const target = byId("page-" + page);
    if (target) target.classList.add("active");

    const pageTitle = PAGE_LABELS[page] || page.charAt(0).toUpperCase() + page.slice(1);
    document.title = `${pageTitle} | ATMABISWAS Fuel`;

    $all(".nav-link[data-page]").forEach((l) => l.classList.toggle("active", l.dataset.page === page));
    $all(".bottom-nav-item[data-page]").forEach((l) => l.classList.toggle("active", l.dataset.page === page));
    byId("breadcrumb").innerHTML = `<span>${PAGE_LABELS[page] || page}</span>`;
    closeSidebar();

    if (page === "add" && editingId === null) resetForm();
    // Render instantly from whatever's already in memory (no spinner, no
    // delay), then quietly refetch in the background — this is what
    // actually keeps Dashboard/Records from going stale in a real office
    // where a Sir or Admin leaves a tab open all day while drivers submit
    // and other sirs approve requests elsewhere. Reports already refetches
    // fresh on every visit (see renderReport()); this brings the other two
    // record-driven pages in line with that instead of only ever reflecting
    // whatever was loaded at login.
    if (page === "records") { renderRecordsTable(); refreshRecordsQuietly(); }
    if (page === "dashboard") { renderDashboard(); refreshRecordsQuietly(); }
    if (page === "settings") renderSettingsLists();
    if (page === "reports") renderReport();
    if (page === "users") renderUserManagementPage();
    if (page === "profile") renderProfilePage();
    if (page === "notifications") renderNotifHistory();

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Background refresh, no loading overlay and no error toast — a stale
  // background poll failing shouldn't interrupt whatever the user is doing;
  // the next successful poll (or a manual page nav) catches the UI back up.
  // Also covers the "left the tab open on Dashboard/Records without
  // clicking anything" case via the interval set up in enterApp().
  async function refreshRecordsQuietly() {
    if (!currentUser) return;
    try {
      const res = await api.getRecords();
      records = res.data;
      if (currentPage === "records") renderRecordsTable();
      if (currentPage === "dashboard") renderDashboard();
    } catch (err) {
      if (err && err.status === 401) handleApiError(err); // session actually expired — still worth surfacing
    }
  }

  /* ============================================================
     DARK MODE
     ============================================================ */
  function initDarkMode() {
    const saved = localStorage.getItem("fsms_theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    updateDarkModeIcon();

    byId("darkModeToggle").addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      const isDark = current === "dark" || (!current && window.matchMedia("(prefers-color-scheme: dark)").matches);
      setTheme(isDark ? "light" : "dark");
    });
  }

  // Theme is a personal, per-browser preference (unlike currency, which is
  // a shared office setting) — it intentionally still lives in LocalStorage
  // alongside the JWT token, rather than round-tripping to the server.
  function getThemePreference() {
    return localStorage.getItem("fsms_theme") || "auto";
  }

  function setTheme(value) {
    if (value === "auto") {
      document.documentElement.removeAttribute("data-theme");
      localStorage.removeItem("fsms_theme");
    } else {
      document.documentElement.setAttribute("data-theme", value);
      localStorage.setItem("fsms_theme", value);
    }
    updateDarkModeIcon();
    refreshChartsTheme();
  }

  function updateDarkModeIcon() {
    const current = document.documentElement.getAttribute("data-theme");
    const isDark = current === "dark" || (!current && window.matchMedia("(prefers-color-scheme: dark)").matches);
    byId("darkModeToggle").innerHTML = isDark
      ? '<i class="fa-solid fa-sun"></i>'
      : '<i class="fa-solid fa-moon"></i>';
  }

  /* ============================================================
     DATA LOADING (replaces the old LocalStorage-based loadState())
     ============================================================ */
  // Fetches every lookup list, the full record set, and office settings in
  // parallel, then populates the in-memory state the rest of the app reads
  // from. Nothing here is persisted anywhere client-side except the JWT
  // (already handled by api.js) and the theme preference (see setTheme()).
  async function loadAllData() {
    const [driversRes, fuelTypesRes, stationsRes, recordsRes, settingsRes] = await Promise.all([
      api.getDrivers(),
      api.getFuelTypes(),
      api.getStations(),
      api.getRecords(),
      api.getSettings(),
    ]);

    drivers = driversRes.data.map((d) => d.name);
    driverIds = {};
    driversRes.data.forEach((d) => { driverIds[d.name] = d.id; });

    fuelTypes = fuelTypesRes.data.map((f) => f.name);
    fuelTypeIds = {};
    fuelTypesRes.data.forEach((f) => { fuelTypeIds[f.name] = f.id; });

    stations = stationsRes.data.map((s) => s.name);
    stationIds = {};
    stationsRes.data.forEach((s) => { stationIds[s.name] = s.id; });

    records = recordsRes.data;

    brandingSettings = settingsRes.data || {};
    officeName = brandingSettings.officeName || DEFAULT_OFFICE_NAME;
    logoPath = brandingSettings.logo || null;
    currencySymbol = brandingSettings.currency || DEFAULT_CURRENCY;

    applyBranding();
    applyCurrencyLabels();
  }

  /* ============ BRANDING (office name / company logo) ============ */
  function getOfficeName() { return officeName || DEFAULT_OFFICE_NAME; }

  // Pushes the current office name / logo into every place they're shown:
  // the login screen, the sidebar, and the top bar. `logoPath` is now a
  // server-relative URL (e.g. "/uploads/logo/x.png") rather than a Base64
  // string, but it plugs into an <img src> exactly the same way.
  function applyBranding() {
    const title = brandingSettings.shortName || brandingSettings.officeName || "ATMABISWAS Fuel";
    byId("officeNameDisplay").textContent = brandingSettings.officeName || title;

    if (currentPage) {
      const pageTitle = PAGE_LABELS[currentPage] || currentPage.charAt(0).toUpperCase() + currentPage.slice(1);
      document.title = `${pageTitle} | ${title}`;
    }

    const logoUrl = brandingSettings.companyLogo || logoPath || "/logo/NGO_logo_monogram.webp";

    $all(".brand-logo-slot").forEach((slot) => {
      slot.innerHTML = `<img src="${logoUrl}" class="brand-logo-img" alt="ATMABISWAS Logo" style="width:100%;height:100%;object-fit:contain;" />`;
    });

    // Update browser favicon dynamically
    const favicons = document.querySelectorAll("link[rel='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']");
    favicons.forEach((fav) => {
      fav.href = logoUrl;
    });
  }

  // Keeps the form's "Price Per Liter (X)" / "Total Amount (X)" labels in
  // sync with whatever currency symbol is configured in Settings.
  function applyCurrencyLabels() {
    byId("priceLabel").textContent = `Price Per Liter (${currencySymbol})`;
    byId("totalLabel").textContent = `Total Amount (${currencySymbol})`;
  }

  /* ============================================================
     DROPDOWNS (Drivers / Sirs / Fuel Types / Stations)
     ============================================================ */
  function populateDropdowns() {
    const driverSelect = byId("fDriver");
    const filterDriver = byId("filterDriver");
    const fuelTypeSelect = byId("fFuelType");
    const stationsDatalist = byId("stationsDatalist");

    const currentDriverVal = driverSelect.value;
    const currentFilterVal = filterDriver.value;
    const currentFuelTypeVal = fuelTypeSelect.value;

    driverSelect.innerHTML = '<option value="">Select driver</option>' +
      drivers.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("") +
      '<option value="__custom__">+ Add custom driver...</option>';

    filterDriver.innerHTML = '<option value="">All Drivers</option>' +
      drivers.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");

    fuelTypeSelect.innerHTML = '<option value="">Select fuel type</option>' +
      fuelTypes.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("");

    // Station Name is a free-text field; the datalist just offers the
    // office's configured stations as autocomplete suggestions.
    stationsDatalist.innerHTML = stations.map((s) => `<option value="${escapeHtml(s)}"></option>`).join("");

    if (drivers.includes(currentDriverVal)) driverSelect.value = currentDriverVal;
    if (currentFilterVal) filterDriver.value = currentFilterVal;
    if (fuelTypes.includes(currentFuelTypeVal)) fuelTypeSelect.value = currentFuelTypeVal;

    // A driver can only ever create/edit records under their own name (the
    // server force-overrides this field regardless — see recordController.js
    // create()/update()) — so lock the dropdown to their own name instead of
    // letting them pick a different driver and then silently ignoring it.
    if (currentUser && currentUser.role === "driver" && currentUser.driverId) {
      const ownName = Object.keys(driverIds).find((name) => driverIds[name] === currentUser.driverId);
      if (ownName) {
        driverSelect.innerHTML = `<option value="${escapeHtml(ownName)}">${escapeHtml(ownName)}</option>`;
        driverSelect.value = ownName;
        driverSelect.disabled = true;
      }
    } else {
      driverSelect.disabled = false;
    }
  }

  // The "+ Add custom driver..." option now creates the entry on the server
  // first (so it's immediately available to everyone else too), and only
  // adds it to the local dropdown once that succeeds.
  function initCustomDropdownHandlers() {
    byId("fDriver").addEventListener("change", function () {
      const select = this;
      if (select.value === "__custom__") {
        openPromptModal(
          "Add New Driver",
          "Enter the new driver's name:",
          "e.g. Md. Salam",
          async (trimmed) => {
            try {
              const res = await api.addDriver(trimmed);
              drivers.push(trimmed);
              driverIds[trimmed] = res.data.id;
              populateDropdowns();
              byId("fDriver").value = trimmed;
            } catch (err) {
              handleApiError(err);
              select.value = "";
            }
          },
          () => { select.value = ""; }
        );
      }
    });
  }

  /* ============================================================
     SETTINGS PAGE (manage drivers / sirs / fuel types / stations)
     ============================================================ */
  // One generic config-driven manager replaces near-identical add/remove/
  // render blocks (drivers, fuel types, stations). Each points at its real
  // API functions instead of a local get/save pair.
  const SIMPLE_LISTS = {
    driver: {
      getArr: () => drivers, getIds: () => driverIds,
      apiAdd: (name) => api.addDriver(name), apiRemove: (id) => api.deleteDriver(id),
      containerId: "driverList", inputId: "newDriverInput", addBtnId: "addDriverBtn",
      label: "Driver", emptyText: "No drivers yet.",
    },
    fuelType: {
      getArr: () => fuelTypes, getIds: () => fuelTypeIds,
      apiAdd: (name) => api.addFuelType(name), apiRemove: (id) => api.deleteFuelType(id),
      containerId: "fuelTypeList", inputId: "newFuelTypeInput", addBtnId: "addFuelTypeBtn",
      label: "Fuel type", emptyText: "No fuel types yet.",
    },
    station: {
      getArr: () => stations, getIds: () => stationIds,
      apiAdd: (name) => api.addStation(name), apiRemove: (id) => api.deleteStation(id),
      containerId: "stationList", inputId: "newStationInput", addBtnId: "addStationBtn",
      label: "Station", emptyText: "No default stations yet.",
    },
  };

  function renderSimpleList(key) {
    const cfg = SIMPLE_LISTS[key];
    const arr = cfg.getArr();
    const ids = cfg.getIds();
    byId(cfg.containerId).innerHTML = arr.length
      ? arr.map((item) => `
        <div class="settings-item">
          <span>${escapeHtml(item)}</span>
          <button data-id="${ids[item]}" data-list="${key}" class="del-simple-item" title="Remove"><i class="fa-solid fa-trash"></i></button>
        </div>`).join("")
      : `<p class="muted">${cfg.emptyText}</p>`;
  }

  function renderSettingsLists() {
    Object.keys(SIMPLE_LISTS).forEach(renderSimpleList);
    byId("settingsCurrency").value = currencySymbol;
    byId("settingsTheme").value = getThemePreference();
    applyBranding();

    const logoUrl = brandingSettings.companyLogo || logoPath || "/logo/NGO_logo_monogram.webp";
    const logoPreview = byId("settingsLogoPreview");
    if (logoPreview) {
      logoPreview.innerHTML = `<img src="${logoUrl}" class="brand-logo-img" alt="ATMABISWAS Logo" style="width:100%;height:100%;object-fit:contain;" />`;
    }
  }

  function initSettingsPage() {
    Object.keys(SIMPLE_LISTS).forEach((key) => {
      const cfg = SIMPLE_LISTS[key];
      byId(cfg.addBtnId).addEventListener("click", async () => {
        const input = byId(cfg.inputId);
        const val = input.value.trim();
        if (!val) return;
        const arr = cfg.getArr();
        if (arr.some((x) => x.toLowerCase() === val.toLowerCase())) {
          showToast(`${cfg.label} already exists`, "warning", "triangle-exclamation");
          return;
        }
        await runWithLoading(async () => {
          const res = await cfg.apiAdd(val);
          arr.push(val);
          cfg.getIds()[val] = res.data.id;
          input.value = "";
          populateDropdowns();
          renderSimpleList(key);
          showToast(`${cfg.label} added`, "success", "check");
        });
      });
    });

    // One delegated handler covers the "remove" button for all four lists.
    document.addEventListener("click", async (e) => {
      const btn = e.target.closest(".del-simple-item");
      if (!btn) return;
      const cfg = SIMPLE_LISTS[btn.dataset.list];
      if (!cfg) return;

      const ids = cfg.getIds();
      const arr = cfg.getArr();
      const id = btn.dataset.id;
      const name = Object.keys(ids).find((n) => String(ids[n]) === String(id));

      await runWithLoading(async () => {
        await cfg.apiRemove(id); // server 409s if still referenced by fuel records
        if (name) {
          arr.splice(arr.indexOf(name), 1);
          delete ids[name];
        }
        populateDropdowns();
        renderSimpleList(btn.dataset.list);
        showToast(`${cfg.label} removed`, "warning", "trash");
      });
    });

    byId("savePreferencesBtn").addEventListener("click", async () => {
      const theme = byId("settingsTheme").value;
      const currency = byId("settingsCurrency").value.trim();
      if (!currency) { showToast("Currency symbol cannot be empty", "warning", "triangle-exclamation"); return; }

      await runWithLoading(async () => {
        setTheme(theme); // personal preference — local only, not sent to the server
        const formData = new FormData();
        formData.append("currency", currency);
        const res = await api.updateSettings(formData);
        currencySymbol = res.data.currency;
        applyCurrencyLabels();
        refreshEverything();
        showToast("Preferences saved", "success", "check");
      });
    });

    byId("clearAllDataBtn").addEventListener("click", () => {
      openConfirm(
        "Clear All Data",
        "This will permanently delete ALL fuel records, drivers, office sirs, and fuel types from the database (and reset them to the starter defaults). This cannot be undone.",
        async () => {
          await runWithLoading(async () => {
            await api.clearAllData();
            await loadAllData();
            refreshEverything();
            showToast("All data cleared", "danger", "trash");
          }, "Clearing all data...");
        }
      );
    });
  }

  /* ============================================================
    byId("logoUploadInput").addEventListener("change", async () => {
      const file = byId("logoUploadInput").files[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        showToast("Please upload an image file", "danger", "triangle-exclamation");
        byId("logoUploadInput").value = "";
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        showToast(`Image is too large (max ${(MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0)}MB)`, "danger", "triangle-exclamation");
        byId("logoUploadInput").value = "";
        return;
      }
      await runWithLoading(async () => {
        const formData = new FormData();
        formData.append("logo", file);
        const res = await api.updateSettings(formData);
        logoPath = res.data.logo;
        applyBranding();
        showToast("Logo updated", "success", "image");
      }, "Uploading logo...");
      byId("logoUploadInput").value = "";
    });

    byId("logoRemoveBtn").addEventListener("click", async () => {
      await runWithLoading(async () => {
        const formData = new FormData();
        formData.append("removeLogo", "true");
        const res = await api.updateSettings(formData);
        logoPath = res.data.logo;
        applyBranding();
        showToast("Logo removed", "warning", "trash");
      });
    });
  }

  /* ============================================================
     UNIFIED LIFECYCLE STATUS BADGES
     Pulled forward from the planned "approval workflow" part because
     renderDashboard() (below) needs statusBadgeHtml() to render its
     tables — these are pure, dependency-free rendering helpers, so
     nothing about the approval workflow itself changes by moving them
     earlier. Not duplicated later.
     ============================================================ */
  const STATUS_META = {
    draft: { label: "Draft", cls: "badge-draft", icon: "fa-solid fa-pen-to-square" },
    pending: { label: "Pending Review", cls: "badge-pending", icon: "fa-solid fa-hourglass-half" },
    review: { label: "Under Review", cls: "badge-review", icon: "fa-solid fa-magnifying-glass" },
    approved: { label: "Approved", cls: "badge-approved", icon: "fa-solid fa-check-double" },
    received: { label: "Fuel Received", cls: "badge-received", icon: "fa-solid fa-gas-pump" },
    not_received: { label: "Fuel Not Received", cls: "badge-not-received", icon: "fa-solid fa-triangle-exclamation" },
  };

  function getStatusKey(r) {
    if (r.isDraft) return "draft";
    if (r.fuelReceived === "received") return "received";
    if (r.fuelReceived === "not_received") return "not_received";
    if (r.approvalStatus === "approved") return "approved";
    if (r.reviewedForApproval) return "review";
    return "pending";
  }

  function statusBadgeHtml(r) {
    const meta = STATUS_META[getStatusKey(r)];
    let html = `<span class="badge ${meta.cls}"><i class="${meta.icon}"></i> ${escapeHtml(meta.label)}</span>`;
    if (r.locked) html += ` <span class="badge badge-locked" title="Locked — an administrator must unlock it to edit"><i class="fa-solid fa-lock"></i> Locked</span>`;
    return html;
  }

  /* ============================================================
     RENDER: DASHBOARD
     Every role reads from the same `records` array — it's already scoped
     server-side (driver: own only; sir/admin: everything) — so this just
     picks which few numbers to show and how to label them per role,
     rather than computing genuinely different data per role.
     ============================================================ */
  function renderDashboard() {
    const role = currentUser ? currentUser.role : "driver";

    const pending = records.filter((r) => r.approvalStatus === "pending").length;
    const approved = records.filter((r) => r.approvalStatus === "approved").length;
    const received = records.filter((r) => r.fuelReceived === "received").length;

    const today = todayISO();
    const approvedToday = records.filter((r) => {
      if (r.approvalStatus !== "approved" || !r.signedAt) return false;
      const d = new Date(r.signedAt);
      const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return localDate === today;
    }).length;

    const thisMonth = today.slice(0, 7);
    const monthCost = records
      .filter((r) => (r.date || "").slice(0, 7) === thisMonth)
      .reduce((sum, r) => sum + Number(r.totalAmount || 0), 0);

    const totalLiters = records.reduce((sum, r) => sum + Number(r.liters || 0), 0);
    byId("statTotal").textContent = records.length;
    byId("statPending").textContent = pending;
    byId("statPendingLabel").textContent = role === "driver" ? "My Pending" : "Pending";
    byId("statApproved").textContent = approved;
    byId("statLiters").textContent = `${totalLiters} L`;
    byId("statMonthCost").textContent = formatMoney(monthCost);

    const recent = [...records].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 4);
    const tbody = $("#recentTable tbody");
    const emptyEl = byId("recentEmpty");
    const recentCardsEl = byId("recentMobileCards");

    if (!recent.length) {
      tbody.innerHTML = "";
      if (recentCardsEl) recentCardsEl.innerHTML = "";
      emptyEl.classList.remove("hidden");
      $("#recentTable").classList.add("hidden");
    } else {
      emptyEl.classList.add("hidden");
      $("#recentTable").classList.remove("hidden");
      tbody.innerHTML = recent.map((r) => `
        <tr>
          <td><strong>${r.id}</strong></td>
          <td>${formatDateDisplay(r.date)}</td>
          <td>${escapeHtml(r.driver)}</td>
          <td>${escapeHtml(r.vehicleNumber)}</td>
          <td>${formatMoney(r.totalAmount)}</td>
          <td>${statusBadgeHtml(r)}</td>
        </tr>
      `).join("");

      if (recentCardsEl) {
        recentCardsEl.innerHTML = recent.map((r) => `
          <div class="mobile-card" data-id="${r.id}">
            <div class="mobile-card-header">
              <div class="mobile-card-title">
                <strong>${r.id}</strong>
                <span style="font-size:12px;color:var(--text-muted);font-weight:normal;margin-left:6px;">${formatDateDisplay(r.date)}</span>
              </div>
              ${statusBadgeHtml(r)}
            </div>
            <div class="mobile-card-body">
              <div class="mobile-card-row">
                <span class="mobile-card-label"><i class="fa-solid fa-user"></i> Driver</span>
                <span class="mobile-card-val">${escapeHtml(r.driver)}</span>
              </div>
              <div class="mobile-card-row">
                <span class="mobile-card-label"><i class="fa-solid fa-car"></i> Vehicle</span>
                <span class="mobile-card-val">${escapeHtml(r.vehicleNumber)}</span>
              </div>
              <div class="mobile-card-row">
                <span class="mobile-card-label"><i class="fa-solid fa-money-bill"></i> Total</span>
                <span class="mobile-card-val" style="color:var(--primary);font-weight:800;">${formatMoney(r.totalAmount)}</span>
              </div>
            </div>
          </div>`).join("");
      }
    }

    const recentApproved = records
      .filter((r) => r.approvalStatus === "approved" && r.signedAt)
      .sort((a, b) => (b.signedAt || 0) - (a.signedAt || 0))
      .slice(0, 4);
    const approvedTbody = $("#recentApprovedTable tbody");
    const approvedEmptyEl = byId("recentApprovedEmpty");
    const approvedCardsEl = byId("recentApprovedMobileCards");

    if (!recentApproved.length) {
      approvedTbody.innerHTML = "";
      if (approvedCardsEl) approvedCardsEl.innerHTML = "";
      approvedEmptyEl.classList.remove("hidden");
      $("#recentApprovedTable").classList.add("hidden");
    } else {
      approvedEmptyEl.classList.add("hidden");
      $("#recentApprovedTable").classList.remove("hidden");
      approvedTbody.innerHTML = recentApproved.map((r) => `
        <tr>
          <td><strong>${r.id}</strong></td>
          <td>${escapeHtml(r.driver)}</td>
          <td>${escapeHtml(r.vehicleNumber)}</td>
          <td>${escapeHtml(r.approvedBy) || "-"}</td>
          <td>${formatTimestamp(r.signedAt)}</td>
          <td>${formatMoney(r.totalAmount)}</td>
        </tr>
      `).join("");

      if (approvedCardsEl) {
        approvedCardsEl.innerHTML = recentApproved.map((r) => `
          <div class="mobile-card" data-id="${r.id}">
            <div class="mobile-card-header">
              <div class="mobile-card-title">
                <strong>${r.id}</strong>
                <span style="font-size:12px;color:var(--text-muted);font-weight:normal;margin-left:6px;">${formatTimestamp(r.signedAt)}</span>
              </div>
              <span class="badge badge-approved"><i class="fa-solid fa-circle-check"></i> Approved</span>
            </div>
            <div class="mobile-card-body">
              <div class="mobile-card-row">
                <span class="mobile-card-label"><i class="fa-solid fa-user"></i> Driver</span>
                <span class="mobile-card-val">${escapeHtml(r.driver)}</span>
              </div>
              <div class="mobile-card-row">
                <span class="mobile-card-label"><i class="fa-solid fa-car"></i> Vehicle</span>
                <span class="mobile-card-val">${escapeHtml(r.vehicleNumber)}</span>
              </div>
              <div class="mobile-card-row">
                <span class="mobile-card-label"><i class="fa-solid fa-user-check"></i> Approved By</span>
                <span class="mobile-card-val">${escapeHtml(r.approvedBy) || "-"}</span>
              </div>
              <div class="mobile-card-row">
                <span class="mobile-card-label"><i class="fa-solid fa-money-bill"></i> Total</span>
                <span class="mobile-card-val" style="color:var(--success);font-weight:800;">${formatMoney(r.totalAmount)}</span>
              </div>
            </div>
          </div>`).join("");
      }
    }
  }

  function refreshChartsTheme() {
    // Dashboard no longer has a chart (simplified to plain stat cards), so
    // there's nothing left to re-theme on dark/light toggle.
  }

  /* ============================================================
     REFRESH ALL (final form)
     ============================================================ */
  function refreshEverything() {
    populateDropdowns();
    renderDashboard();
    renderRecordsTable();
    if (currentPage === "settings") renderSettingsLists();
    if (currentPage === "reports") renderReport(); // async — fires and updates the DOM once it resolves
  }

  /* ============================================================
     CONFIRM MODAL (generic)
     ============================================================ */
  let pendingConfirmCancel = null;

  function openConfirm(title, message, onConfirm, onCancel) {
    byId("confirmTitle").innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(title)}`;
    byId("confirmMessage").textContent = message;
    pendingConfirmAction = onConfirm;
    pendingConfirmCancel = onCancel || null;
    byId("confirmModal").classList.remove("hidden");
  }

  function initConfirmModal() {
    byId("confirmOkBtn").addEventListener("click", () => {
      if (typeof pendingConfirmAction === "function") pendingConfirmAction();
      pendingConfirmAction = null;
      pendingConfirmCancel = null;
      byId("confirmModal").classList.add("hidden");
    });
    byId("confirmCancelBtn").addEventListener("click", closeConfirmModal);
    byId("closeConfirmModal").addEventListener("click", closeConfirmModal);
  }
  function closeConfirmModal() {
    pendingConfirmAction = null;
    byId("confirmModal").classList.add("hidden");
    const cancel = pendingConfirmCancel;
    pendingConfirmCancel = null;
    if (typeof cancel === "function") cancel();
  }

  /* ============================================================
     PROMPT MODAL (generic) — replaces browser prompt() dialogs
     ============================================================ */
  let pendingPromptSubmit = null;
  let pendingPromptCancel = null;

  function openPromptModal(title, message, placeholder, onSubmit, onCancel, inputType) {
    byId("promptTitle").innerHTML = `<i class="fa-solid fa-pen"></i> ${escapeHtml(title)}`;
    byId("promptMessage").textContent = message || "";
    const input = byId("promptInput");
    input.value = "";
    input.type = inputType || "text";
    input.placeholder = placeholder || "";
    byId("promptError").textContent = "";
    pendingPromptSubmit = onSubmit;
    pendingPromptCancel = onCancel || null;
    byId("promptModal").classList.remove("hidden");
    setTimeout(() => input.focus(), 50);
  }

  function submitPromptModal() {
    const input = byId("promptInput");
    const trimmed = input.value.trim();
    if (!trimmed) {
      byId("promptError").textContent = "This field cannot be empty.";
      return;
    }
    if (input.type === "password" && trimmed.length < 6) {
      byId("promptError").textContent = "Password must be at least 6 characters.";
      return;
    }
    byId("promptModal").classList.add("hidden");
    input.type = "text";
    const submit = pendingPromptSubmit;
    pendingPromptSubmit = null;
    pendingPromptCancel = null;
    if (typeof submit === "function") submit(trimmed);
  }

  function closePromptModal() {
    byId("promptModal").classList.add("hidden");
    byId("promptInput").type = "text";
    const cancel = pendingPromptCancel;
    pendingPromptSubmit = null;
    pendingPromptCancel = null;
    if (typeof cancel === "function") cancel();
  }

  function initPromptModal() {
    byId("promptOkBtn").addEventListener("click", submitPromptModal);
    byId("promptCancelBtn").addEventListener("click", closePromptModal);
    byId("closePromptModal").addEventListener("click", closePromptModal);
    byId("promptInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submitPromptModal(); }
    });
  }

  /* ============================================================
     IMAGE ENLARGE MODAL
     ============================================================ */
  let imgZoomLevel = 1;
  const IMG_ZOOM_MIN = 1;
  const IMG_ZOOM_MAX = 4;
  const IMG_ZOOM_STEP = 0.25;

  function openImageModal(src, title) {
    byId("imgModalTitle").textContent = title;
    byId("imgModalImage").src = src;
    byId("downloadImgBtn").href = src;
    byId("downloadImgBtn").download = (title || "image").replace(/\s+/g, "_") + ".jpg";
    byId("imgModal").classList.remove("hidden");
    setImgZoom(1);
  }

  // Applies `level` as a CSS transform scale on the enlarged image and
  // updates the zoom-percent readout in the modal footer.
  function setImgZoom(level) {
    imgZoomLevel = Math.min(IMG_ZOOM_MAX, Math.max(IMG_ZOOM_MIN, level));
    const img = byId("imgModalImage");
    img.style.transform = `scale(${imgZoomLevel})`;
    img.classList.toggle("zoomed", imgZoomLevel > 1);
    byId("zoomLevel").textContent = Math.round(imgZoomLevel * 100) + "%";
  }

  function initImageModal() {
    byId("closeImgModal").addEventListener("click", () => byId("imgModal").classList.add("hidden"));
    byId("zoomInBtn").addEventListener("click", () => setImgZoom(imgZoomLevel + IMG_ZOOM_STEP));
    byId("zoomOutBtn").addEventListener("click", () => setImgZoom(imgZoomLevel - IMG_ZOOM_STEP));
    byId("zoomResetBtn").addEventListener("click", () => setImgZoom(1));

    // Click the image itself to toggle zoomed in/out, and scroll-wheel to
    // zoom in/out continuously — both common, expected zoom interactions.
    byId("imgModalImage").addEventListener("click", () => {
      setImgZoom(imgZoomLevel > 1 ? 1 : 2);
    });
    byId("imgModalBody").addEventListener("wheel", (e) => {
      e.preventDefault();
      setImgZoom(imgZoomLevel + (e.deltaY < 0 ? IMG_ZOOM_STEP : -IMG_ZOOM_STEP));
    }, { passive: false });
  }

  /* ============================================================
     IMAGE HANDLING (compress client-side, upload the real file)
     ============================================================ */
  // Resolves { blob, previewUrl }: `blob` is what actually gets uploaded
  // (via FormData), `previewUrl` is a data URL used only to show the
  // preview instantly in the upload box — it is never sent to the server.
  function readAndCompressImage(file) {
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith("image/")) { reject(new Error("Please upload an image file (JPG, PNG, etc.)")); return; }
      if (file.size > MAX_UPLOAD_BYTES) { reject(new Error(`Image is too large (max ${(MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0)}MB)`)); return; }
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (!width || !height) { reject(new Error("Could not read image dimensions — file may be corrupted")); return; }
          if (width > IMG_MAX_WIDTH) {
            height = Math.round(height * (IMG_MAX_WIDTH / width));
            width = IMG_MAX_WIDTH;
          }
          const canvas = document.createElement("canvas");
          canvas.width = width; canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
          const previewUrl = canvas.toDataURL("image/jpeg", IMG_QUALITY);
          canvas.toBlob((blob) => {
            if (!blob) { reject(new Error("Could not process the image")); return; }
            resolve({ blob, previewUrl });
          }, "image/jpeg", IMG_QUALITY);
        };
        img.onerror = () => reject(new Error("File is not a valid image"));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error("Could not read the selected file"));
      reader.readAsDataURL(file);
    });
  }

  // Shared by every upload path (file picker, drag-drop, native camera
  // capture, and the in-page webcam modal) — one place that validates,
  // compresses, and stages a File/Blob into the form's image state, so
  // every source gets identical format/size/corruption checks.
  async function applyImageFile(file, previewEl, placeholderEl, removeBtnEl, stateKey, errorFieldId) {
    showLoading("Processing image..."); // resizing/compressing large photos can take a moment
    try {
      const { blob, previewUrl } = await readAndCompressImage(file);
      formImages[stateKey] = blob;
      removedImages[stateKey] = false;
      previewEl.src = previewUrl;
      previewEl.classList.remove("hidden");
      placeholderEl.classList.add("hidden");
      removeBtnEl.classList.remove("hidden");
      if (errorFieldId) clearFieldError(errorFieldId);
      return true;
    } catch (err) {
      showToast(err.message || "Could not read image file", "danger", "triangle-exclamation");
      return false;
    } finally {
      hideLoading();
    }
  }

  // The two MANDATORY photo fields (Fuel Machine Display / Money Receipt)
  // get the richer camera+gallery workflow: a dedicated native-capture input
  // (mobile), the in-page webcam modal (desktop, see openCameraCapture()),
  // and an explicit gallery/file picker — on top of the same click-box and
  // drag-drop convenience the simpler fields already had.
  function setupMandatoryUploadBox(boxId, galleryInputId, captureInputId, placeholderId, previewId, removeId, stateKey) {
    const box = byId(boxId);
    const galleryInput = byId(galleryInputId);
    const captureInput = byId(captureInputId);
    const placeholder = byId(placeholderId);
    const preview = byId(previewId);
    const removeBtn = byId(removeId);

    box.addEventListener("click", (e) => {
      if (e.target === removeBtn || removeBtn.contains(e.target)) return;
      galleryInput.click();
    });

    async function handleFileInput(input) {
      const file = input.files[0];
      if (!file) return;
      const ok = await applyImageFile(file, preview, placeholder, removeBtn, stateKey, galleryInputId);
      if (!ok) input.value = "";
    }
    galleryInput.addEventListener("change", () => handleFileInput(galleryInput));
    captureInput.addEventListener("change", () => handleFileInput(captureInput));

    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      formImages[stateKey] = null;
      if (existingImagePaths[stateKey]) removedImages[stateKey] = true;
      galleryInput.value = "";
      captureInput.value = "";
      preview.src = "";
      preview.classList.add("hidden");
      placeholder.classList.remove("hidden");
      removeBtn.classList.add("hidden");
    });

    ["dragover", "dragenter"].forEach((evt) => box.addEventListener(evt, (e) => { e.preventDefault(); box.classList.add("dragover"); }));
    ["dragleave", "drop"].forEach((evt) => box.addEventListener(evt, (e) => { e.preventDefault(); box.classList.remove("dragover"); }));
    box.addEventListener("drop", (e) => {
      const file = e.dataTransfer.files[0];
      if (file) { galleryInput.files = e.dataTransfer.files; galleryInput.dispatchEvent(new Event("change")); }
    });
  }

  /* ============================================================
     CAMERA CAPTURE MODAL (webcam on desktop; falls back to the native
     capture-attribute input, which is what actually launches the camera
     app on Android/iPhone, if getUserMedia is unavailable or refused)
     ============================================================ */
  const MANDATORY_PHOTO_TARGETS = {
    1: { galleryInput: "fFuelReceiptImg", captureInput: "fFuelReceiptImgCapture", preview: "preview1", placeholder: "placeholder1", removeBtn: "remove1", stateKey: "fuelReceipt" },
    2: { galleryInput: "fMoneyReceiptImg", captureInput: "fMoneyReceiptImgCapture", preview: "preview2", placeholder: "placeholder2", removeBtn: "remove2", stateKey: "moneyReceipt" },
  };

  let cameraStream = null;
  let cameraTargetCfg = null; // which MANDATORY_PHOTO_TARGETS entry the open modal applies to

  function stopCameraStream() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
    byId("cameraVideo").srcObject = null;
    byId("cameraVideo").onloadeddata = null;
  }

  // The camera stream can take a moment (anywhere from ~100ms to over a
  // second) to actually start delivering frames after getUserMedia()
  // resolves. Capturing before that point draws a blank/black frame from
  // the <video> element — this is what was producing solid-black "photos".
  // The Capture button stays disabled until the video genuinely has data.
  function setCameraCaptureReady(ready) {
    const btn = byId("cameraCaptureBtn");
    btn.disabled = !ready;
    btn.innerHTML = ready
      ? '<i class="fa-solid fa-camera"></i> Capture Photo'
      : '<i class="fa-solid fa-spinner fa-spin"></i> Starting camera...';
  }

  function checkCameraReadyAndUpdateButton() {
    const video = byId("cameraVideo");
    const ready = video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
    setCameraCaptureReady(ready);
    return ready;
  }

  function resetCameraModalUI() {
    byId("cameraError").classList.add("hidden");
    byId("cameraCapturedPreview").classList.add("hidden");
    byId("cameraCapturedPreview").src = "";
    byId("cameraRetakeBtn").classList.add("hidden");
    byId("cameraSaveBtn").classList.add("hidden");
    byId("cameraCaptureBtn").classList.remove("hidden");
    byId("cameraVideo").classList.remove("hidden");
    // On a fresh open the stream has no frames yet (disabled until
    // 'loadeddata' fires below); on a Retake the stream is already warmed
    // up, so this immediately re-enables the button instead of waiting
    // for an event that already fired once and won't fire again.
    checkCameraReadyAndUpdateButton();
  }

  function closeCameraModal() {
    stopCameraStream();
    byId("cameraModal").classList.add("hidden");
    cameraTargetCfg = null;
  }

  // Tries the live in-page webcam first (works on both desktop and mobile
  // browsers that support it); if the API is missing, permission is denied,
  // or no camera is found, falls back to clicking the hidden capture-attribute
  // input, which on Android/iPhone launches the device's native camera app.
  async function openCameraCapture(targetCfg) {
    cameraTargetCfg = targetCfg;
    resetCameraModalUI();
    byId("cameraModal").classList.remove("hidden");

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      byId("cameraModal").classList.add("hidden");
      byId(targetCfg.captureInput).click();
      return;
    }

    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      const video = byId("cameraVideo");
      video.srcObject = cameraStream;
      video.onloadeddata = () => checkCameraReadyAndUpdateButton();
      checkCameraReadyAndUpdateButton(); // in the rare case it's already ready
    } catch (err) {
      byId("cameraModal").classList.add("hidden");
      byId(targetCfg.captureInput).click();
    }
  }

  function captureCameraFrame() {
    const video = byId("cameraVideo");
    // Defense in depth: the Capture button is disabled until the stream is
    // ready, but guard here too in case of a stray click race — refuse
    // rather than silently saving a black frame.
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      showToast("Camera is still starting up — please wait a moment and try again.", "warning", "hourglass-half");
      return;
    }
    const canvas = byId("cameraCanvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);

    byId("cameraCapturedPreview").src = canvas.toDataURL("image/jpeg", 0.9);
    byId("cameraCapturedPreview").classList.remove("hidden");
    byId("cameraVideo").classList.add("hidden");
    byId("cameraCaptureBtn").classList.add("hidden");
    byId("cameraRetakeBtn").classList.remove("hidden");
    byId("cameraSaveBtn").classList.remove("hidden");
  }

  // Discards the just-captured frame and returns to the live feed — the
  // camera stream itself was never stopped, so this is instant. Nothing is
  // ever auto-submitted: the user must explicitly retake or confirm.
  function retakeCameraPhoto() {
    resetCameraModalUI();
  }

  async function useCapturedCameraPhoto() {
    const targetCfg = cameraTargetCfg;
    if (!targetCfg) return;
    const canvas = byId("cameraCanvas");

    canvas.toBlob(async (blob) => {
      if (!blob) {
        showToast("Could not process the captured photo. Please retake.", "danger", "triangle-exclamation");
        return;
      }
      const file = new File([blob], "camera-capture.jpg", { type: "image/jpeg" });
      closeCameraModal();
      // Same validate-and-compress pipeline every other source goes through.
      await applyImageFile(
        file, byId(targetCfg.preview), byId(targetCfg.placeholder), byId(targetCfg.removeBtn),
        targetCfg.stateKey, targetCfg.galleryInput
      );
    }, "image/jpeg", 0.9);
  }

  function initCameraModal() {
    byId("cameraCaptureBtn").addEventListener("click", captureCameraFrame);
    byId("cameraRetakeBtn").addEventListener("click", retakeCameraPhoto);
    byId("cameraSaveBtn").addEventListener("click", useCapturedCameraPhoto);
    byId("cameraCancelBtn").addEventListener("click", closeCameraModal);
    byId("closeCameraModal").addEventListener("click", closeCameraModal);
  }

  function initMandatoryPhotoButtons() {
    $all(".upload-gallery-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cfg = MANDATORY_PHOTO_TARGETS[btn.dataset.target];
        byId(cfg.galleryInput).click();
      });
    });
    $all(".upload-camera-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        openCameraCapture(MANDATORY_PHOTO_TARGETS[btn.dataset.target]);
      });
    });
  }

  // formImages: new file Blobs staged for upload (null = no new file chosen).
  // existingImagePaths: server paths of images already saved on the record
  // being edited (null when adding a new record).
  // removedImages: true if the user explicitly removed an existing image
  // without picking a replacement — tells the server to clear it.
  let formImages = { fuelReceipt: null, moneyReceipt: null };
  let existingImagePaths = { fuelReceipt: null, moneyReceipt: null };
  let removedImages = { fuelReceipt: false, moneyReceipt: false };

  /* ============================================================
     FORM: ADD / EDIT REQUEST
     ============================================================ */
  function initForm() {
    byId("fDate").value = todayISO();

    byId("fLiters").addEventListener("input", recalcTotal);
    byId("fPrice").addEventListener("input", recalcTotal);

    byId("resetFormBtn").addEventListener("click", () => resetForm());
    byId("saveDraftBtn").addEventListener("click", saveAsDraft);

    byId("fuelForm").addEventListener("submit", handleFormSubmit);

    setupMandatoryUploadBox("uploadBox1", "fFuelReceiptImg", "fFuelReceiptImgCapture", "placeholder1", "preview1", "remove1", "fuelReceipt");
    setupMandatoryUploadBox("uploadBox2", "fMoneyReceiptImg", "fMoneyReceiptImgCapture", "placeholder2", "preview2", "remove2", "moneyReceipt");
  }

  function recalcTotal() {
    const liters = parseFloat(byId("fLiters").value) || 0;
    const price = parseFloat(byId("fPrice").value) || 0;
    const total = liters * price;
    byId("fTotal").value = total > 0 ? formatMoney(total) : "";
  }

  function clearFieldError(fieldId) {
    const errEl = byId("err-" + fieldId);
    if (errEl) errEl.textContent = "";
    const field = byId(fieldId);
    if (field && field.closest(".form-field")) field.closest(".form-field").classList.remove("error");
    const uploadField = field && field.closest(".upload-field");
    if (uploadField) uploadField.classList.remove("error");
  }

  function setFieldError(fieldId, message) {
    const errEl = byId("err-" + fieldId);
    if (errEl) errEl.textContent = message;
    const field = byId(fieldId);
    if (field && field.closest(".form-field")) field.closest(".form-field").classList.add("error");
  }

  // `isDraft` relaxes the required-field list to just enough to identify the
  // record later (date/driver/vehicle); everything else stays optional.
  function validateForm({ isDraft = false } = {}) {
    let valid = true;

    const requiredFields = [
      ["fDate", "Date is required"],
      ["fDriver", "Driver is required"],
      ["fVehicle", "Vehicle number is required"],
    ];
    if (!isDraft) {
      requiredFields.push(
        ["fFuelType", "Fuel type is required"],
        ["fLiters", "Fuel quantity is required"]
      );
    }
    requiredFields.forEach(([id, msg]) => {
      const el = byId(id);
      clearFieldError(id);
      if (!el.value || (id === "fLiters" && parseFloat(el.value) <= 0)) {
        setFieldError(id, msg);
        valid = false;
      }
    });

    // Future-date guard — a fuel request can't be dated ahead of today.
    clearFieldError("fDate");
    if (byId("fDate").value && byId("fDate").value > todayISO()) {
      setFieldError("fDate", "Date cannot be in the future");
      valid = false;
    }

    // Negative-value guards.
    clearFieldError("fLiters");
    if (byId("fLiters").value && parseFloat(byId("fLiters").value) < 0) {
      setFieldError("fLiters", "Quantity cannot be negative");
      valid = false;
    }
    clearFieldError("fPrice");
    if (byId("fPrice").value !== "" && parseFloat(byId("fPrice").value) < 0) {
      setFieldError("fPrice", "Price cannot be negative");
      valid = false;
    }

    if (!isDraft) {
      clearFieldError("fFuelReceiptImg");
      clearFieldError("fMoneyReceiptImg");
      // Valid if a new file was picked THIS session, OR an existing image
      // is already on the record and hasn't been explicitly removed.
      const hasFuelReceipt = formImages.fuelReceipt || (existingImagePaths.fuelReceipt && !removedImages.fuelReceipt);
      const hasMoneyReceipt = formImages.moneyReceipt || (existingImagePaths.moneyReceipt && !removedImages.moneyReceipt);
      if (!hasFuelReceipt) {
        setFieldError("fFuelReceiptImg", "Fuel Machine Display Photo is required — it must show Liters, Price per Liter, and Total Amount.");
        byId("uploadBox1").closest(".upload-field").classList.add("error");
        valid = false;
      }
      if (!hasMoneyReceipt) {
        setFieldError("fMoneyReceiptImg", "Money Receipt Photo is required.");
        byId("uploadBox2").closest(".upload-field").classList.add("error");
        valid = false;
      }
    }
    return valid;
  }

  // Builds the multipart FormData sent to the API — text fields plus
  // whichever image Blobs were newly picked (or explicit "remove" flags
  // for images the user cleared without replacing).
  async function buildPayloadFromForm(isDraft) {
    const formData = new FormData();
    formData.append("date", byId("fDate").value);
    formData.append("driver", byId("fDriver").value);
    formData.append("vehicleNumber", byId("fVehicle").value.trim());
    formData.append("fuelType", byId("fFuelType").value);
    formData.append("liters", byId("fLiters").value || "0");
    formData.append("pricePerLiter", byId("fPrice").value || "0");
    formData.append("remarks", byId("fRemarks").value.trim());
    formData.append("stationName", byId("fStationName").value.trim());
    formData.append("isDraft", isDraft ? "true" : "false");

    const fileFieldNames = {
      fuelReceipt: "fuelReceiptImage",
      moneyReceipt: "moneyReceiptImage",
    };
    for (const key of Object.keys(fileFieldNames)) {
      const fieldName = fileFieldNames[key];
      if (formImages[key]) {
        const compressed = await compressImageFile(formImages[key]);
        formData.append(fieldName, compressed, key + ".jpg");
      } else if (removedImages[key]) {
        formData.append("remove" + fieldName.charAt(0).toUpperCase() + fieldName.slice(1), "true");
      }
    }

    return formData;
  }

  async function createNewRecord(formData) {
    const res = await api.createRecord(formData);
    records.unshift(res.data);
    showToast(
      res.data.isDraft ? `Draft ${res.data.id} saved` : `Request ${res.data.id} submitted`,
      "success", res.data.isDraft ? "pen" : "circle-check"
    );
  }

  function toastForRecordUpdate(original, updated) {
    if (original.isDraft && !updated.isDraft) {
      showToast(`Request ${updated.id} completed from draft`, "success", "circle-check");
    } else if (original.isDraft && updated.isDraft) {
      showToast(`Draft ${updated.id} updated`, "success", "pen");
    } else if (original.locked && !updated.locked && updated.approvalStatus === "pending") {
      showToast(`Request ${updated.id} updated — approval revoked (details changed)`, "warning", "triangle-exclamation");
    } else {
      showToast(`Request ${updated.id} updated`, "success", "pen");
    }
  }

  async function applyEditToRecord(code, formData) {
    const idx = records.findIndex((r) => r.id === code);
    const original = records[idx];
    const res = await api.updateRecord(code, formData);
    records[idx] = res.data;
    toastForRecordUpdate(original, res.data);
  }

  async function persistRecordFromForm(isDraft) {
    const formData = await buildPayloadFromForm(isDraft);
    await runWithLoading(async () => {
      if (editingId) {
        await applyEditToRecord(editingId, formData);
        editingId = null;
      } else {
        await createNewRecord(formData);
      }
      resetForm();
      refreshEverything();
      goToPage("records");
    }, isDraft ? "Saving draft..." : "Submitting request...");
  }

  // Jumps straight to the first invalid field (and focuses it) so a
  // validation failure doesn't just leave the user staring at a generic
  // toast — this matters most for the Driver/Sir/Fuel Type dropdowns, which
  // are easy to miss when attention is on filling in the photos below them.
  function scrollToFirstError() {
    const firstError = document.querySelector(".form-field.error, .upload-field.error");
    if (!firstError) return;
    firstError.scrollIntoView({ behavior: "smooth", block: "center" });
    const field = firstError.querySelector("input, select, textarea");
    if (field) field.focus({ preventScroll: true });
  }

  function handleFormSubmit(e) {
    e.preventDefault();
    if (!validateForm({ isDraft: false })) {
      showToast("Please fix the highlighted fields below", "danger", "triangle-exclamation");
      scrollToFirstError();
      return;
    }
    persistRecordFromForm(false);
  }

  function saveAsDraft() {
    if (!validateForm({ isDraft: true })) {
      showToast("A draft needs at least Date, Driver and Vehicle Number", "danger", "triangle-exclamation");
      scrollToFirstError();
      return;
    }
    persistRecordFromForm(true);
  }

  function resetForm() {
    editingId = null;
    byId("recordId").value = "";
    byId("fuelForm").reset();
    byId("fDate").value = todayISO();
    byId("fTotal").value = "";
    byId("fStationName").value = "";
    formImages = { fuelReceipt: null, moneyReceipt: null };
    existingImagePaths = { fuelReceipt: null, moneyReceipt: null };
    removedImages = { fuelReceipt: false, moneyReceipt: false };
    ["1", "2"].forEach((n) => {
      byId("preview" + n).classList.add("hidden");
      byId("preview" + n).src = "";
      byId("placeholder" + n).classList.remove("hidden");
      byId("remove" + n).classList.add("hidden");
    });
    $all(".field-error").forEach((el) => (el.textContent = ""));
    $all(".form-field.error, .upload-field.error").forEach((el) => el.classList.remove("error"));
    byId("formTitle").textContent = "Add New Fuel Request";
    byId("saveRecordBtn").innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit Request';
    byId("editApprovedNotice").classList.add("hidden");

    if (currentUser && currentUser.profilePhoto) {
      byId("fDriverPhotoPreview").src = currentUser.profilePhoto;
      byId("fDriverPhotoPreview").classList.remove("hidden");
      byId("fDriverPhotoPlaceholder").classList.add("hidden");
    } else {
      byId("fDriverPhotoPreview").src = "";
      byId("fDriverPhotoPreview").classList.add("hidden");
      byId("fDriverPhotoPlaceholder").classList.remove("hidden");
    }
  }

  function loadRecordIntoForm(record) {
    editingId = record.id;
    byId("recordId").value = record.id;
    byId("fDate").value = record.date;
    populateDropdowns();
    byId("fDriver").value = record.driver;
    byId("fVehicle").value = record.vehicleNumber;
    byId("fFuelType").value = record.fuelType;
    byId("fLiters").value = record.liters;
    byId("fPrice").value = record.pricePerLiter;
    recalcTotal();
    byId("fRemarks").value = record.remarks || "";
    byId("fStationName").value = record.stationName || "";

    const photoSrc = record.driverPhotoImage || (currentUser && currentUser.profilePhoto);
    if (photoSrc) {
      byId("fDriverPhotoPreview").src = photoSrc;
      byId("fDriverPhotoPreview").classList.remove("hidden");
      byId("fDriverPhotoPlaceholder").classList.add("hidden");
    } else {
      byId("fDriverPhotoPreview").src = "";
      byId("fDriverPhotoPreview").classList.add("hidden");
      byId("fDriverPhotoPlaceholder").classList.remove("hidden");
    }

    formImages = { fuelReceipt: null, moneyReceipt: null };
    removedImages = { fuelReceipt: false, moneyReceipt: false };
    existingImagePaths = {
      fuelReceipt: record.fuelReceiptImage || null,
      moneyReceipt: record.moneyReceiptImage || null,
    };

    const imgMap = { 1: existingImagePaths.fuelReceipt, 2: existingImagePaths.moneyReceipt };
    Object.keys(imgMap).forEach((n) => {
      if (imgMap[n]) {
        byId("preview" + n).src = imgMap[n];
        byId("preview" + n).classList.remove("hidden");
        byId("placeholder" + n).classList.add("hidden");
        byId("remove" + n).classList.remove("hidden");
      } else {
        byId("preview" + n).classList.add("hidden");
        byId("preview" + n).src = "";
        byId("placeholder" + n).classList.remove("hidden");
        byId("remove" + n).classList.add("hidden");
      }
    });

    byId("formTitle").textContent = `Edit Request ${record.id}`;
    byId("saveRecordBtn").innerHTML = '<i class="fa-solid fa-paper-plane"></i> Update Request';

    // Warn the user (without touching any data) if this record is already approved.
    byId("editApprovedNotice").classList.toggle("hidden", record.approvalStatus !== "approved");

    goToPage("add");
  }

  function editRecord(id) {
    const record = records.find((r) => r.id === id);
    if (!record) return;

    if (record.locked) {
      // Real role-based auth now makes the old password re-entry step
      // redundant — requireRole("admin") on the server IS the security
      // boundary. Non-admins simply can't get past it; only offer the
      // unlock flow to admins.
      if (!currentUser || currentUser.role !== "admin") {
        showToast("This request is locked. Only an administrator can unlock it for editing.", "warning", "lock");
        return;
      }
      openConfirm(
        "Unlock Request",
        `Request ${id} is approved and locked. Unlock it for editing?`,
        async () => {
          await runWithLoading(async () => {
            const res = await api.unlockRecord(id);
            const idx = records.findIndex((r) => r.id === id);
            if (idx > -1) records[idx] = res.data;
            refreshEverything();
            showToast(`Request ${id} unlocked for editing`, "warning", "unlock");
            loadRecordIntoForm(res.data);
          });
        }
      );
      return;
    }

    // NOTE: approval status / signature are intentionally left untouched here.
    // They are only revoked later, server-side, if the user actually changes
    // approval-sensitive fields and saves the form.
    loadRecordIntoForm(record);
  }

  function deleteRecord(id) {
    openConfirm(
      "Delete Request",
      `Are you sure you want to delete request ${id}? This action cannot be undone.`,
      async () => {
        await runWithLoading(async () => {
          await api.deleteRecord(id);
          records = records.filter((r) => r.id !== id);
          refreshEverything();
          showToast(`Request ${id} deleted`, "danger", "trash");
        });
      }
    );
  }

  /* ============================================================
     RENDER: RECORDS TABLE
     Pulled forward from the planned "approval workflow" part: the table
     needs to render the Approve/Sign and Got-Fuel/Not-Got action buttons
     even though those buttons' click handlers (openSignModal,
     setFuelReceived) aren't implemented until the next part. Clicking
     them will throw until then — expected at this stage, not a bug.
     ============================================================ */
  function statusBadges(r) {
    // Approving/signing and setting fuel status are sir/admin-only actions
    // server-side (see recordRoutes.js) — a driver clicking these would just
    // get a 403, so show plain read-only status text for them instead of an
    // actionable-looking button they can't actually use.
    const canApprove = currentUser && (currentUser.role === "admin" || currentUser.role === "sir");

    let approval;
    if (r.isDraft) {
      approval = `<span class="muted" style="font-size:12.5px;">Complete &amp; save to submit</span>`;
    } else if (r.approvalStatus === "approved") {
      approval = `<span class="signed-label"><i class="fa-solid fa-circle-check"></i> Signed</span>`;
    } else if (!canApprove) {
      approval = r.reviewedForApproval
        ? `<span class="muted" style="font-size:12.5px;">Awaiting Sir's Signature</span>`
        : `<span class="muted" style="font-size:12.5px;">Awaiting Sir's Review</span>`;
    } else if (r.reviewedForApproval) {
      approval = `<button class="approve-btn" data-act="sign" data-id="${r.id}"><i class="fa-solid fa-signature"></i> Approve &amp; Sign</button>`;
    } else {
      approval = `<button class="approve-btn review-first-btn" data-act="reviewFirst" data-id="${r.id}"><i class="fa-solid fa-eye"></i> Review to Approve</button>`;
    }

    let fuelBtns;
    if (canApprove) {
      const fuelDisabled = r.approvalStatus !== "approved";
      fuelBtns = `
        <div class="fuel-status-btns">
          <button class="btn-got ${r.fuelReceived === "received" ? "active" : ""}" data-act="received" data-id="${r.id}" ${fuelDisabled ? "disabled" : ""}>
            <i class="fa-solid fa-circle-check"></i> Got Fuel
          </button>
          <button class="btn-not-got ${r.fuelReceived === "not_received" ? "active" : ""}" data-act="notreceived" data-id="${r.id}" ${fuelDisabled ? "disabled" : ""}>
            <i class="fa-solid fa-circle-xmark"></i> Not Got
          </button>
        </div>`;
    } else if (r.fuelReceived === "received") {
      fuelBtns = `<span class="badge badge-received"><i class="fa-solid fa-gas-pump"></i> Fuel Received</span>`;
    } else if (r.fuelReceived === "not_received") {
      fuelBtns = `<span class="badge badge-not-received"><i class="fa-solid fa-triangle-exclamation"></i> Fuel Not Received</span>`;
    } else {
      fuelBtns = `<span class="badge badge-unset">Not Set</span>`;
    }

    return { approval, fuelBtns };
  }

  // Builds one lowercase "haystack" string per record so search can match
  // Record ID, driver, vehicle, station, date, or amount.
  function searchHaystack(r) {
    return [
      r.id, r.driver, r.sirName, r.vehicleNumber, r.stationName || "",
      r.receiptNumber || "", r.date || "", formatDateDisplay(r.date),
      r.totalAmount != null ? String(r.totalAmount) : "",
      r.liters != null ? String(r.liters) : "",
    ].join(" ").toLowerCase();
  }

  function filteredRecords() {
    const q = (byId("recordsSearch")?.value || "").trim().toLowerCase();
    const status = byId("filterStatus")?.value || "";
    const received = byId("filterReceived")?.value || "";
    const driver = byId("filterDriver")?.value || "";
    const date = byId("filterDate")?.value || "";

    return records.filter((r) => {
      if (q && !searchHaystack(r).includes(q)) return false;
      if (status === "draft" && !r.isDraft) return false;
      if (status && status !== "draft" && r.approvalStatus !== status) return false;
      if (received) {
        if (received === "unset" && r.fuelReceived) return false;
        if (received !== "unset" && r.fuelReceived !== received) return false;
      }
      if (driver && r.driver !== driver) return false;
      if (date && r.date !== date) return false;
      return true;
    });
  }

  // Small ✅/❌ badge used for the Machine Photo / Money Receipt presence
  // indicators in the Records table and Reports "Matching Records" table.
  function yesNoBadge(isPresent) {
    return isPresent
      ? `<span class="badge badge-yes"><i class="fa-solid fa-check"></i> Yes</span>`
      : `<span class="badge badge-no"><i class="fa-solid fa-xmark"></i> No</span>`;
  }

  function renderRecordsTable() {
    const list = filteredRecords();
    const tbody = $("#recordsTable tbody");
    const emptyEl = byId("recordsEmpty");

    if (!list.length) {
      tbody.innerHTML = "";
      emptyEl.classList.remove("hidden");
      $("#recordsTable").classList.add("hidden");
      if (byId("recordsMobileCards")) byId("recordsMobileCards").innerHTML = "";
    } else {
      emptyEl.classList.add("hidden");
      $("#recordsTable").classList.remove("hidden");
      tbody.innerHTML = list.map((r) => {
        const { approval, fuelBtns } = statusBadges(r);
        return `
        <tr>
          <td><strong>${r.id}</strong></td>
          <td>${formatDateDisplay(r.date)}</td>
          <td>${escapeHtml(r.driver)}</td>
          <td>${escapeHtml(r.vehicleNumber)}</td>
          <td>${escapeHtml(r.fuelType) || "-"}</td>
          <td>${r.liters || 0} L</td>
          <td>${formatMoney(r.totalAmount)}</td>
          <td>${r.fuelReceiptImage ? `<img src="${r.fuelReceiptImage}" class="mini-thumb" data-src="${r.fuelReceiptImage}" data-title="Fuel Machine Display Photo - ${r.id}" />` : '<span class="no-img">-</span>'}</td>
          <td>${r.moneyReceiptImage ? `<img src="${r.moneyReceiptImage}" class="mini-thumb" data-src="${r.moneyReceiptImage}" data-title="Money Receipt Photo - ${r.id}" />` : '<span class="no-img">-</span>'}</td>
          <td>${yesNoBadge(!!r.fuelReceiptImage)}</td>
          <td>${yesNoBadge(!!r.moneyReceiptImage)}</td>
          <td>${statusBadgeHtml(r)}</td>
          <td>${approval}</td>
          <td>${fuelBtns}</td>
          <td>
            <div class="row-actions">
              <button class="act-view" data-act="view" data-id="${r.id}" title="View"><i class="fa-solid fa-eye"></i></button>
              <button class="act-edit" data-act="edit" data-id="${r.id}" title="${r.locked ? "Locked — click to request unlock" : "Edit"}"><i class="fa-solid ${r.locked ? "fa-lock" : "fa-pen"}"></i></button>
              ${currentUser && currentUser.role === "admin" ? `<button class="act-delete" data-act="delete" data-id="${r.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>` : ""}
            </div>
          </td>
        </tr>`;
      }).join("");
      renderRecordsMobileCards();
    }
  }

  function initRecordsTableEvents() {
    document.addEventListener("click", (e) => {
      const thumb = e.target.closest(".mini-thumb");
      if (thumb) { openImageModal(thumb.dataset.src, thumb.dataset.title); return; }

      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      if (act === "view") openViewModal(id);
      else if (act === "edit") editRecord(id);
      else if (act === "delete") deleteRecord(id);
      else if (act === "sign") openSignModal(id);
      else if (act === "reviewFirst") openViewModal(id);
      else if (act === "received") setFuelReceived(id, "received");
      else if (act === "notreceived") setFuelReceived(id, "not_received");
    });

    const debouncedRender = debounce(renderRecordsTable, 200);
    byId("recordsSearch").addEventListener("input", debouncedRender);
    ["filterStatus", "filterReceived", "filterDriver", "filterDate"].forEach((id) => {
      byId(id).addEventListener("change", renderRecordsTable);
    });

    byId("clearFilters").addEventListener("click", () => {
      byId("recordsSearch").value = "";
      byId("filterStatus").value = "";
      byId("filterReceived").value = "";
      byId("filterDriver").value = "";
      byId("filterDate").value = "";
      renderRecordsTable();
    });

    const handleGlobalSearch = debounce((e) => {
      byId("recordsSearch").value = e.target.value;
      if (currentPage !== "records") goToPage("records");
      else renderRecordsTable();
    }, 200);

    byId("globalSearch")?.addEventListener("input", handleGlobalSearch);
    byId("mobileGlobalSearch")?.addEventListener("input", handleGlobalSearch);
  }

  /* ============================================================
     VIEW RECORD MODAL
     ============================================================ */
  // Builds one mandatory-photo card (Fuel Machine Display / Money Receipt)
  // with its own explicit "Mark as Reviewed" control — the Approve & Sign
  // gate (statusBadges()/openSignModal()) only opens once BOTH cards show
  // "Reviewed", not just because the modal was opened.
  function isOlderThan90Days(dateStr) {
    if (!dateStr) return false;
    const created = new Date(dateStr).getTime();
    const diffDays = (Date.now() - created) / (1000 * 60 * 60 * 24);
    return diffDays >= 90;
  }

  function getPhotoPlaceholderHtml(record, imagePath, photoType) {
    if (imagePath) return null;
    if (record.isDraft) {
      return `<div class="photo-missing-box"><i class="fa-regular fa-image"></i><span>Not uploaded yet</span></div>`;
    }
    const isOld = isOlderThan90Days(record.date || record.createdAt);
    if (isOld && (photoType === "fuelReceipt" || photoType === "moneyReceipt" || photoType === "vehiclePhoto")) {
      return `<div class="photo-missing-box retention"><i class="fa-solid fa-clock-rotate-left"></i><span>Photo Deleted (Retention Policy)</span></div>`;
    }
    if (photoType === "signature") {
      return record.approvalStatus === "approved"
        ? `<div class="photo-missing-box admin-deleted"><i class="fa-solid fa-signature"></i><span>Signature Removed by Administrator</span></div>`
        : `<div class="photo-missing-box"><i class="fa-solid fa-pen-line"></i><span>Not signed yet</span></div>`;
    }
    if (photoType === "driverPhoto") {
      return `<div class="photo-missing-box"><i class="fa-solid fa-circle-user"></i><span>Default Avatar</span></div>`;
    }
    return `<div class="photo-missing-box admin-deleted"><i class="fa-solid fa-trash-can"></i><span>Photo Deleted by Administrator</span></div>`;
  }

  function mandatoryPhotoCard(record, target, imagePath, title, isReviewed) {
    const canReview = currentUser && (currentUser.role === "admin" || currentUser.role === "sir");
    const isAdmin = currentUser && currentUser.role === "admin";
    const photoType = target === "machine" ? "fuelReceipt" : "moneyReceipt";

    let reviewControl;
    if (isReviewed) {
      reviewControl = `<div class="reviewed-confirmation"><i class="fa-solid fa-circle-check"></i> Reviewed</div>`;
    } else if (canReview) {
      reviewControl = `<button type="button" class="review-photo-btn" data-review-target="${target}" data-id="${record.id}"><i class="fa-solid fa-magnifying-glass"></i> Mark as Reviewed</button>`;
    } else {
      reviewControl = `<div class="reviewed-confirmation" style="background:var(--warning-light);color:var(--warning);"><i class="fa-solid fa-hourglass-half"></i> Awaiting Sir's Review</div>`;
    }

    const deleteBtn = (isAdmin && imagePath)
      ? `<button type="button" class="btn btn-danger btn-xs admin-delete-photo-btn" data-code="${record.id}" data-photo-type="${photoType}" style="margin-top:6px;width:100%;"><i class="fa-solid fa-trash"></i> Delete Photo (Admin)</button>`
      : "";

    return `
      <div class="mandatory-photo-card ${isReviewed ? "is-reviewed" : ""}">
        <div class="photo-caption"><span>${title}</span></div>
        ${imagePath
          ? `<img src="${imagePath}" data-title="${title} - ${record.id}" class="viewable-img" />`
          : getPhotoPlaceholderHtml(record, imagePath, photoType)}
        ${reviewControl}
        ${deleteBtn}
      </div>
    `;
  }

  async function openViewModal(id) {
    const r = records.find((x) => x.id === id);
    if (!r) return;
    byId("viewModalId").textContent = r.id;

    const isAdmin = currentUser && currentUser.role === "admin";
    const sigPlaceholder = getPhotoPlaceholderHtml(r, r.signature, "signature");
    const driverPlaceholder = getPhotoPlaceholderHtml(r, r.driverPhotoImage, "driverPhoto");
    const vehiclePlaceholder = getPhotoPlaceholderHtml(r, r.vehiclePhotoImage, "vehiclePhoto");

    const sigDeleteBtn = (isAdmin && r.signature)
      ? `<br/><button type="button" class="btn btn-danger btn-xs admin-delete-photo-btn" data-code="${r.id}" data-photo-type="signature" style="margin-top:4px;"><i class="fa-solid fa-trash"></i> Delete Signature</button>`
      : "";
    const driverDeleteBtn = (isAdmin && r.driverPhotoImage)
      ? `<br/><button type="button" class="btn btn-danger btn-xs admin-delete-photo-btn" data-code="${r.id}" data-photo-type="driverPhoto" style="margin-top:4px;"><i class="fa-solid fa-trash"></i> Delete Photo</button>`
      : "";
    const vehicleDeleteBtn = (isAdmin && r.vehiclePhotoImage)
      ? `<br/><button type="button" class="btn btn-danger btn-xs admin-delete-photo-btn" data-code="${r.id}" data-photo-type="vehiclePhoto" style="margin-top:4px;"><i class="fa-solid fa-trash"></i> Delete Photo</button>`
      : "";

    const history = Array.isArray(r.history) ? r.history : [];
    const historyHtml = history.length
      ? `<ul class="history-timeline">${history.map((h) => `
          <li>
            <span class="history-dot"></span>
            <div class="history-body">
              <strong>${escapeHtml(h.action)}</strong>
              <span class="history-meta">${escapeHtml(h.by)} &middot; ${formatTimestamp(h.at)}</span>
              ${h.note ? `<span class="history-note">${escapeHtml(h.note)}</span>` : ""}
            </div>
          </li>`).join("")}</ul>`
      : `<p class="muted">No history recorded for this request yet.</p>`;

    byId("viewModalBody").innerHTML = `
      <div class="detail-grid">
        <div class="detail-item"><label>Driver Name</label><span>${escapeHtml(r.driver)}</span></div>
        <div class="detail-item"><label>Vehicle Number</label><span>${escapeHtml(r.vehicleNumber)}</span></div>
        <div class="detail-item"><label>Fuel Type</label><span>${escapeHtml(r.fuelType)}</span></div>
        <div class="detail-item"><label>Date &amp; Time</label><span>${formatDateDisplay(r.date)}, ${escapeHtml(r.time)}</span></div>
        <div class="detail-item"><label>Receipt Number</label><span>${escapeHtml(r.receiptNumber) || "-"}</span></div>
        <div class="detail-item"><label>Fuel Station Name</label><span>${escapeHtml(r.stationName) || "-"}</span></div>
        <div class="detail-item"><label>Odometer / KM Reading</label><span>${r.odometer != null && r.odometer !== "" ? r.odometer + " km" : "-"}</span></div>
        <div class="detail-item"><label>Fuel Quantity</label><span>${r.liters} Liters</span></div>
        <div class="detail-item"><label>Total Cost</label><span>${formatMoney(r.totalAmount)}</span></div>
        <div class="detail-item"><label>Status</label><div>${statusBadgeHtml(r)}</div></div>
        <div class="detail-item"><label>Approved By</label><span>${escapeHtml(r.approvedBy) || "-"}</span></div>
        <div class="detail-item"><label>Approval Date &amp; Time</label><span>${formatTimestamp(r.signedAt)}</span></div>
        <div class="detail-item full"><label>Driver's Remarks</label><span>${escapeHtml(r.remarks) || "No remarks"}</span></div>
        <div class="detail-item full"><label>Office Remarks (Sir)</label><span>${escapeHtml(r.officeRemarks) || "No office remarks"}</span></div>
      </div>
      <div class="mandatory-photos-section">
        <h4><i class="fa-solid fa-triangle-exclamation" style="color:var(--warning);"></i> Mandatory Review — Both Required Before Approval</h4>
        <div class="mandatory-photos-grid">
          ${mandatoryPhotoCard(r, "machine", r.fuelReceiptImage, "Fuel Machine Display Photo", r.machinePhotoReviewed)}
          ${mandatoryPhotoCard(r, "money", r.moneyReceiptImage, "Money Receipt Photo", r.moneyReceiptReviewed)}
        </div>
      </div>
      <div class="detail-images">
        <figure>
          ${r.signature
            ? `<img src="${r.signature}" data-title="Signature - ${r.id}" class="viewable-img" style="object-fit:contain;background:#fff;" />`
            : sigPlaceholder}
          <figcaption>Sir Signature ${sigDeleteBtn}</figcaption>
        </figure>
        <figure>
          ${r.driverPhotoImage
            ? `<img src="${r.driverPhotoImage}" data-title="Driver Photo - ${r.id}" class="viewable-img" />`
            : driverPlaceholder}
          <figcaption>Driver Photo ${driverDeleteBtn}</figcaption>
        </figure>
        <figure>
          ${r.vehiclePhotoImage
            ? `<img src="${r.vehiclePhotoImage}" data-title="Vehicle Photo - ${r.id}" class="viewable-img" />`
            : vehiclePlaceholder}
          <figcaption>Vehicle Photo ${vehicleDeleteBtn}</figcaption>
        </figure>
      </div>
      <div class="history-section">
        <h4><i class="fa-solid fa-clock-rotate-left"></i> Approval History</h4>
        ${historyHtml}
      </div>
    `;

    $all(".viewable-img").forEach((img) => {
      img.addEventListener("click", () => openImageModal(img.src, img.dataset.title));
    });

    $all(".admin-delete-photo-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const code = btn.dataset.code;
        const photoType = btn.dataset.photoType;
        const reason = prompt("Enter deletion reason (optional):") || "";
        if (confirm("Are you sure you want to delete this photo permanently? This action will be logged.")) {
          btn.disabled = true;
          try {
            const res = await api.deleteRecordPhoto(code, photoType, reason);
            showToast("Photo deleted successfully.", "success");
            const idx = records.findIndex((x) => x.id === code);
            if (idx > -1) records[idx] = res.data;
            renderRecordsTable();
            openViewModal(code);
          } catch (err) {
            showToast(err.message || "Failed to delete photo.", "danger");
            btn.disabled = false;
          }
        }
      });
    });

    // Wires each mandatory photo's "Mark as Reviewed" button (only rendered
    // for admin/sir roles — see mandatoryPhotoCard()). Re-opens the modal
    // afterward so its own state (and the records table's Approve & Sign
    // gate) reflects the change immediately.
    $all(".review-photo-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const target = btn.dataset.reviewTarget;
        const recordId = btn.dataset.id;
        btn.disabled = true;
        try {
          const res = await api.reviewRecordImage(recordId, target);
          const idx = records.findIndex((x) => x.id === recordId);
          if (idx > -1) records[idx] = res.data;
          showToast(
            target === "machine" ? "Machine display photo marked as reviewed" : "Money receipt photo marked as reviewed",
            "success", "check"
          );
          if (currentPage === "records") renderRecordsTable();
          openViewModal(recordId);
        } catch (err) {
          handleApiError(err);
          btn.disabled = false;
        }
      });
    });

    byId("printRecordBtn").onclick = () => printRecord(r.id);
    byId("viewModal").classList.remove("hidden");
  }

  function initViewModal() {
    byId("closeViewModal").addEventListener("click", closeViewModalAndRefresh);
    byId("closeViewModalBtn").addEventListener("click", closeViewModalAndRefresh);
  }

  // Closing the View modal may have just satisfied the review-before-approve
  // gate, so the records table needs to re-render to reveal "Approve & Sign".
  function closeViewModalAndRefresh() {
    byId("viewModal").classList.add("hidden");
    if (currentPage === "records") renderRecordsTable();
  }

  /* ============================================================
     USER MANAGEMENT PAGE (admin only)
     ============================================================ */
  let manageUsers = [];       // cached admin user list, re-fetched on render/search/filter
  let editingUserId = null;   // null = create mode, else the numeric id being edited
  let userPhotoFile = null;   // staged Blob for the create/edit modal's profile photo
  let userPhotoRemoved = false;

  function roleBadgeHtml(role) {
    const labels = { admin: "Admin", sir: "Sir", driver: "Driver" };
    return `<span class="role-badge role-badge-${role}">${labels[role] || role}</span>`;
  }

  function statusPillHtml(isActive) {
    return isActive
      ? `<span class="status-pill status-pill-active"><i class="fa-solid fa-circle-check"></i> Active</span>`
      : `<span class="status-pill status-pill-inactive"><i class="fa-solid fa-circle-xmark"></i> Inactive</span>`;
  }

  function formatLastLogin(value) {
    if (!value) return "Never";
    return formatTimestamp(value);
  }

  async function renderUserManagementPage() {
    if (!currentUser || currentUser.role !== "admin") return; // page is admin-only; nav already hides it
    await runWithLoading(async () => {
      const search = byId("userSearch").value.trim();
      const role = byId("userFilterRole").value;
      const status = byId("userFilterStatus").value;
      const res = await api.getUsers({ search, role, status });
      manageUsers = res.data;
      renderUsersTable();
    }, "Loading users...");
  }

  function renderUsersTable() {
    const tbody = $("#usersTable tbody");
    const emptyEl = byId("usersEmpty");
    const usersCardsEl = byId("usersMobileCards");

    if (!manageUsers.length) {
      tbody.innerHTML = "";
      if (usersCardsEl) usersCardsEl.innerHTML = "";
      emptyEl.classList.remove("hidden");
      $("#usersTable").classList.add("hidden");
      return;
    }
    emptyEl.classList.add("hidden");
    $("#usersTable").classList.remove("hidden");

    tbody.innerHTML = manageUsers.map((u) => {
      const photoCell = u.profile_photo
        ? `<img src="${u.profile_photo}" class="avatar-thumb" alt="" />`
        : `<div class="avatar-thumb-fallback">${escapeHtml((u.full_name || u.username).charAt(0).toUpperCase())}</div>`;
      const isSelf = currentUser.id === u.id;

      return `
      <tr>
        <td>${photoCell}</td>
        <td><strong>${escapeHtml(u.full_name)}</strong>${u.employee_id ? `<div class="muted" style="font-size:11.5px;">ID: ${escapeHtml(u.employee_id)}</div>` : ""}</td>
        <td>${escapeHtml(u.username)}</td>
        <td>${roleBadgeHtml(u.role)}</td>
        <td>${statusPillHtml(!!u.is_active)}</td>
        <td>${formatLastLogin(u.last_login_at)}</td>
        <td>
          <div class="row-actions">
            <button class="act-edit" data-uact="edit" data-id="${u.id}" title="Edit"><i class="fa-solid fa-pen"></i></button>
            <button class="act-view" data-uact="reset" data-id="${u.id}" title="Reset Password"><i class="fa-solid fa-key"></i></button>
            ${isSelf ? "" : `<button class="act-edit" data-uact="${u.is_active ? "deactivate" : "activate"}" data-id="${u.id}" title="${u.is_active ? "Deactivate" : "Activate"}"><i class="fa-solid ${u.is_active ? "fa-user-slash" : "fa-user-check"}"></i></button>`}
            ${isSelf ? "" : `<button class="act-delete" data-uact="delete" data-id="${u.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>`}
          </div>
        </td>
      </tr>`;
    }).join("");

    if (usersCardsEl) {
      usersCardsEl.innerHTML = manageUsers.map((u) => {
        const isSelf = currentUser.id === u.id;
        return `
        <div class="mobile-card" data-id="${u.id}">
          <div class="mobile-card-header">
            <div style="display:flex;align-items:center;gap:10px;">
              ${u.profile_photo
                ? `<img src="${u.profile_photo}" class="avatar-thumb" alt="" />`
                : `<div class="avatar-thumb-fallback">${escapeHtml((u.full_name || u.username).charAt(0).toUpperCase())}</div>`}
              <div>
                <strong style="font-size:14px;display:block;">${escapeHtml(u.full_name)}</strong>
                <span style="font-size:12px;color:var(--text-muted);">@${escapeHtml(u.username)}</span>
              </div>
            </div>
            ${roleBadgeHtml(u.role)}
          </div>
          <div class="mobile-card-body">
            <div class="mobile-card-row">
              <span class="mobile-card-label"><i class="fa-solid fa-shield-halved"></i> Status</span>
              <span class="mobile-card-val">${statusPillHtml(!!u.is_active)}</span>
            </div>
            <div class="mobile-card-row">
              <span class="mobile-card-label"><i class="fa-solid fa-clock-rotate-left"></i> Last Login</span>
              <span class="mobile-card-val" style="font-size:12px;">${formatLastLogin(u.last_login_at)}</span>
            </div>
          </div>
          <div class="mobile-card-footer">
            <div class="mobile-card-actions">
              <button class="btn btn-outline btn-xs" data-uact="edit" data-id="${u.id}"><i class="fa-solid fa-pen"></i> Edit</button>
              <button class="btn btn-outline btn-xs" data-uact="reset" data-id="${u.id}"><i class="fa-solid fa-key"></i> Key</button>
              ${isSelf ? "" : `<button class="btn btn-ghost btn-xs" data-uact="${u.is_active ? "deactivate" : "activate"}" data-id="${u.id}"><i class="fa-solid ${u.is_active ? "fa-user-slash" : "fa-user-check"}"></i></button>`}
              ${isSelf ? "" : `<button class="btn btn-ghost btn-xs text-danger" data-uact="delete" data-id="${u.id}"><i class="fa-solid fa-trash"></i></button>`}
            </div>
          </div>
        </div>`;
      }).join("");
    }
  }

  function toggleUserRoleFields(role) {
    byId("driverFieldsGroup").classList.toggle("hidden", role !== "driver");
    byId("sirFieldsGroup").classList.toggle("hidden", role !== "sir");
  }

  function openUserModal(mode, userId) {
    editingUserId = mode === "edit" ? userId : null;
    userPhotoFile = null;
    userPhotoRemoved = false;

    byId("userForm").reset();
    ["uFullName", "uUsername", "uPassword", "uRole", "uEmployeeId"].forEach((id) => { byId("err-" + id).textContent = ""; });
    byId("userAvatarPreview").src = "";
    byId("userAvatarPreview").classList.add("hidden");
    byId("userAvatarPlaceholder").classList.remove("hidden");

    byId("uDefaultFuelType").innerHTML = '<option value="">None</option>' +
      fuelTypes.map((f) => `<option value="${fuelTypeIds[f]}">${escapeHtml(f)}</option>`).join("");

    if (mode === "edit") {
      const u = manageUsers.find((x) => x.id === userId);
      if (!u) return;
      byId("userModalTitle").innerHTML = '<i class="fa-solid fa-user-pen"></i> Edit User';
      byId("uId").value = u.id;
      byId("uFullName").value = u.full_name || "";
      byId("uUsername").value = u.username || "";
      byId("uUsername").disabled = true; // username is permanent once created
      byId("uPasswordField").classList.add("hidden"); // password changes go through "Reset Password", not Edit
      byId("uRole").value = u.role;
      byId("uRole").disabled = true; // role is permanent once created (it owns a linked driver/sir profile)
      byId("uPhone").value = u.phone || "";
      byId("uEmail").value = u.email || "";
      byId("uEmployeeId").value = u.employee_id || "";
      byId("uVehicleNumbers").value = Array.isArray(u.vehicle_numbers) ? u.vehicle_numbers.join(", ") : "";
      byId("uDefaultFuelType").value = u.default_fuel_type_id || "";
      byId("uDepartment").value = u.department || "";
      byId("uDesignation").value = u.designation || "";
      if (u.profile_photo) {
        byId("userAvatarPreview").src = u.profile_photo;
        byId("userAvatarPreview").classList.remove("hidden");
        byId("userAvatarPlaceholder").classList.add("hidden");
      }
      toggleUserRoleFields(u.role);
    } else {
      byId("userModalTitle").innerHTML = '<i class="fa-solid fa-user-plus"></i> Add User';
      byId("uId").value = "";
      byId("uUsername").disabled = false;
      byId("uPasswordField").classList.remove("hidden");
      byId("uRole").disabled = false;
      toggleUserRoleFields("");
    }

    byId("userModal").classList.remove("hidden");
  }

  function closeUserModal() {
    byId("userModal").classList.add("hidden");
  }

  async function handleUserFormSubmit() {
    ["uFullName", "uUsername", "uPassword", "uRole", "uEmployeeId"].forEach((id) => { byId("err-" + id).textContent = ""; });

    const fullName = byId("uFullName").value.trim();
    const username = byId("uUsername").value.trim();
    const password = byId("uPassword").value;
    const role = byId("uRole").value;
    let valid = true;

    if (!fullName) { byId("err-uFullName").textContent = "Full name is required."; valid = false; }
    if (!editingUserId && !username) { byId("err-uUsername").textContent = "Username is required."; valid = false; }
    if (!editingUserId && (!password || password.length < 6)) {
      byId("err-uPassword").textContent = "Password must be at least 6 characters."; valid = false;
    }
    if (!role) { byId("err-uRole").textContent = "Role is required."; valid = false; }
    if (!valid) return;

    const formData = new FormData();
    formData.append("fullName", fullName);
    formData.append("phone", byId("uPhone").value.trim());
    formData.append("email", byId("uEmail").value.trim());
    formData.append("employeeId", byId("uEmployeeId").value.trim());
    if (role === "driver") {
      formData.append("vehicleNumbers", byId("uVehicleNumbers").value.trim());
      formData.append("defaultFuelTypeId", byId("uDefaultFuelType").value);
    }
    if (role === "sir") {
      formData.append("department", byId("uDepartment").value.trim());
      formData.append("designation", byId("uDesignation").value.trim());
    }
    if (userPhotoFile) formData.append("profilePhoto", userPhotoFile, "photo.jpg");
    if (userPhotoRemoved && !userPhotoFile) formData.append("removeProfilePhoto", "true");

    await runWithLoading(async () => {
      if (editingUserId) {
        await api.updateUser(editingUserId, formData);
        showToast("User updated", "success", "check");
      } else {
        formData.append("username", username);
        formData.append("password", password);
        formData.append("role", role);
        await api.createUser(formData);
        showToast("User created", "success", "check");
      }
      closeUserModal();
      await renderUserManagementPage();
    }, editingUserId ? "Saving user..." : "Creating user...");
  }

  function initUserPhotoUpload() {
    byId("userPhotoBtn").addEventListener("click", () => byId("userPhotoInput").click());
    byId("userAvatarBox").addEventListener("click", () => byId("userPhotoInput").click());

    byId("userPhotoInput").addEventListener("change", async () => {
      const file = byId("userPhotoInput").files[0];
      if (!file) return;
      showLoading("Processing photo...");
      try {
        const { blob, previewUrl } = await readAndCompressImage(file);
        userPhotoFile = blob;
        userPhotoRemoved = false;
        byId("userAvatarPreview").src = previewUrl;
        byId("userAvatarPreview").classList.remove("hidden");
        byId("userAvatarPlaceholder").classList.add("hidden");
      } catch (err) {
        showToast(err.message || "Could not read image file", "danger", "triangle-exclamation");
      } finally {
        hideLoading();
        byId("userPhotoInput").value = "";
      }
    });

    byId("userPhotoRemoveBtn").addEventListener("click", () => {
      userPhotoFile = null;
      userPhotoRemoved = true;
      byId("userAvatarPreview").src = "";
      byId("userAvatarPreview").classList.add("hidden");
      byId("userAvatarPlaceholder").classList.remove("hidden");
    });
  }

  function initUserManagementPage() {
    byId("addUserBtn").addEventListener("click", () => openUserModal("create"));
    byId("closeUserModal").addEventListener("click", closeUserModal);
    byId("cancelUserModal").addEventListener("click", closeUserModal);
    byId("saveUserBtn").addEventListener("click", handleUserFormSubmit);
    byId("userForm").addEventListener("submit", (e) => { e.preventDefault(); handleUserFormSubmit(); });
    byId("uRole").addEventListener("change", (e) => toggleUserRoleFields(e.target.value));

    initUserPhotoUpload();

    const debouncedSearch = debounce(() => renderUserManagementPage(), 300);
    byId("userSearch").addEventListener("input", debouncedSearch);
    byId("userFilterRole").addEventListener("change", () => renderUserManagementPage());
    byId("userFilterStatus").addEventListener("change", () => renderUserManagementPage());

    document.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-uact]");
      if (!btn) return;
      const act = btn.dataset.uact;
      const id = Number(btn.dataset.id);
      const u = manageUsers.find((x) => x.id === id);
      if (!u) return;

      if (act === "edit") {
        openUserModal("edit", id);
      } else if (act === "reset") {
        openPromptModal(
          "Reset Password",
          `Enter a new password for "${u.username}":`,
          "New password (min 6 characters)",
          async (value) => {
            await runWithLoading(async () => {
              await api.resetUserPassword(id, value);
              showToast("Password reset", "success", "key");
            });
          },
          null,
          "password"
        );
      } else if (act === "activate") {
        runWithLoading(async () => {
          await api.activateUser(id);
          showToast(`${u.full_name} activated`, "success", "check");
          await renderUserManagementPage();
        });
      } else if (act === "deactivate") {
        openConfirm(
          "Deactivate User",
          `Deactivate "${u.full_name}"? They will no longer be able to log in.`,
          async () => {
            await runWithLoading(async () => {
              await api.deactivateUser(id);
              showToast(`${u.full_name} deactivated`, "warning", "user-slash");
              await renderUserManagementPage();
            });
          }
        );
      } else if (act === "delete") {
        openConfirm(
          "Delete User",
          `Permanently delete the login account for "${u.full_name}"? Their historical fuel records will be kept.`,
          async () => {
            await runWithLoading(async () => {
              await api.deleteUser(id);
              showToast(`${u.full_name} deleted`, "danger", "trash");
              await renderUserManagementPage();
            });
          }
        );
      }
    });
  }

  /* ============================================================
     PROFILE PAGE (self-service, all roles)
     ============================================================ */
  let profilePhotoFile = null;
  let profilePhotoRemoved = false;

  // Maps the /users/me (snake_case DB row) shape onto the same camelCase
  // shape currentUser already has from login/me, so applyRoleVisibility()
  // and the topbar keep working after a self-service profile update.
  function mapProfileToCurrentUser(u) {
    return {
      id: u.id, username: u.username, fullName: u.full_name, role: u.role,
      driverId: u.driver_id, sirId: u.sir_id, phone: u.phone, email: u.email,
      employeeId: u.employee_id, profilePhoto: u.profile_photo,
    };
  }

  function isValidBdPhone(phone) {
    if (!phone || typeof phone !== "string") return false;
    const trimmed = phone.trim().replace(/[\s-]/g, "");
    let numStr = trimmed;
    if (numStr.startsWith("+88")) {
      numStr = numStr.slice(3);
    } else if (numStr.startsWith("88")) {
      numStr = numStr.slice(2);
    }
    return /^01[3-9]\d{8}$/.test(numStr);
  }

  function formatDateTimeLocal(dtStr) {
    if (!dtStr) return "Never";
    const d = new Date(dtStr);
    if (isNaN(d.getTime())) return dtStr;
    return d.toLocaleString("en-US", {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
  }

  async function loadProfileAuditLogs() {
    try {
      const tbody = byId("profileAuditBody");
      if (!tbody) return;
      const res = await api.getMyAuditLogs();
      const logs = res.data || [];
      if (!logs.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted" style="padding: 16px;">No security or profile audit logs recorded yet.</td></tr>';
        return;
      }
      tbody.innerHTML = logs.map((log) => {
        let badgeClass = "badge-neutral";
        if (log.action.includes("Password")) badgeClass = "badge-danger";
        else if (log.action.includes("Phone")) badgeClass = "badge-warning";
        else if (log.action.includes("Picture")) badgeClass = "badge-info";
        else if (log.action.includes("Profile")) badgeClass = "badge-success";
        return `
          <tr>
            <td>${formatDateTimeLocal(log.created_at)}</td>
            <td><span class="badge ${badgeClass}">${escapeHtml(log.action)}</span></td>
            <td><code>${escapeHtml(log.ip_address || "Client IP")}</code></td>
            <td>${escapeHtml(log.note || "-")}</td>
          </tr>
        `;
      }).join("");
    } catch (err) {
      console.error("Error loading audit logs:", err);
    }
  }

  function verificationStatusBadgeHtml(status) {
    if (!status) status = "Pending Verification";
    let badgeClass = "badge-pending";
    let iconClass = "fa-clock";
    if (status === "Verified") {
      badgeClass = "badge-approved";
      iconClass = "fa-circle-check";
    } else if (status === "Rejected") {
      badgeClass = "badge-rejected";
      iconClass = "fa-circle-xmark";
    } else if (status === "Expired Documents") {
      badgeClass = "badge-rejected";
      iconClass = "fa-triangle-exclamation";
    }
    return `<span class="badge ${badgeClass}"><i class="fa-solid ${iconClass}"></i> ${escapeHtml(status)}</span>`;
  }

  async function loadDriverProfileSection() {
    const cardEl = byId("driverProfileCard");
    if (!cardEl) return;
    if (!currentUser || currentUser.role !== "driver") {
      cardEl.classList.add("hidden");
      return;
    }
    cardEl.classList.remove("hidden");

    try {
      const res = await api.getDriverProfile();
      const dp = res.data || {};

      if (byId("driverVerificationBadge")) {
        byId("driverVerificationBadge").innerHTML = verificationStatusBadgeHtml(dp.verification_status);
      }

      if (byId("driverDob")) byId("driverDob").value = dp.dob ? dp.dob.slice(0, 10) : "";
      if (byId("driverGender")) byId("driverGender").value = dp.gender || "";
      if (byId("driverBloodGroup")) byId("driverBloodGroup").value = dp.blood_group || "";
      if (byId("driverEmergencyName")) byId("driverEmergencyName").value = dp.emergency_contact_name || "";
      if (byId("driverEmergencyNumber")) byId("driverEmergencyNumber").value = dp.emergency_contact_number || "";
      if (byId("driverPresentAddress")) byId("driverPresentAddress").value = dp.present_address || "";
      if (byId("driverPermanentAddress")) byId("driverPermanentAddress").value = dp.permanent_address || "";

      if (byId("driverNidNumber")) byId("driverNidNumber").value = dp.nid_number || "";
      if (byId("driverNidIssueDate")) byId("driverNidIssueDate").value = dp.nid_issue_date ? dp.nid_issue_date.slice(0, 10) : "";
      if (byId("driverNidExpiryDate")) byId("driverNidExpiryDate").value = dp.nid_expiry_date ? dp.nid_expiry_date.slice(0, 10) : "";

      if (byId("driverLicenseNumber")) byId("driverLicenseNumber").value = dp.license_number || "";
      if (byId("driverLicenseCategory")) byId("driverLicenseCategory").value = dp.license_category || "";
      if (byId("driverLicenseAuthority")) byId("driverLicenseAuthority").value = dp.license_authority || "";
      if (byId("driverLicenseIssueDate")) byId("driverLicenseIssueDate").value = dp.license_issue_date ? dp.license_issue_date.slice(0, 10) : "";
      if (byId("driverLicenseExpiryDate")) byId("driverLicenseExpiryDate").value = dp.license_expiry_date ? dp.license_expiry_date.slice(0, 10) : "";

      const setDocPreview = (previewId, placeholderId, path) => {
        const previewEl = byId(previewId);
        const placeholderEl = byId(placeholderId);
        if (path && previewEl) {
          previewEl.src = path;
          previewEl.classList.remove("hidden");
          if (placeholderEl) placeholderEl.classList.add("hidden");
        } else if (previewEl) {
          previewEl.src = "";
          previewEl.classList.add("hidden");
          if (placeholderEl) placeholderEl.classList.remove("hidden");
        }
      };

      setDocPreview("nidFrontPreview", "nidFrontPlaceholder", dp.nid_front_image);
      setDocPreview("nidBackPreview", "nidBackPlaceholder", dp.nid_back_image);
      setDocPreview("licenseFrontPreview", "licenseFrontPlaceholder", dp.license_front_image);
      setDocPreview("licenseBackPreview", "licenseBackPlaceholder", dp.license_back_image);
    } catch (err) {
      console.warn("Could not load driver profile details:", err.message);
    }
  }

  async function handleDriverProfileSubmit(e) {
    e.preventDefault();
    const nidNumber = byId("driverNidNumber")?.value.trim() || "";
    const licenseNumber = byId("driverLicenseNumber")?.value.trim() || "";
    const issueDate = byId("driverLicenseIssueDate")?.value || "";
    const expiryDate = byId("driverLicenseExpiryDate")?.value || "";

    if (issueDate && expiryDate && new Date(expiryDate) < new Date(issueDate)) {
      showToast("Driving License Expiry Date cannot be earlier than Issue Date.", "warning", "triangle-exclamation");
      return;
    }

    const formData = new FormData();
    formData.append("dob", byId("driverDob")?.value || "");
    formData.append("gender", byId("driverGender")?.value || "");
    formData.append("bloodGroup", byId("driverBloodGroup")?.value || "");
    formData.append("emergencyContactName", byId("driverEmergencyName")?.value.trim() || "");
    formData.append("emergencyContactNumber", byId("driverEmergencyNumber")?.value.trim() || "");
    formData.append("presentAddress", byId("driverPresentAddress")?.value.trim() || "");
    formData.append("permanentAddress", byId("driverPermanentAddress")?.value.trim() || "");

    formData.append("nidNumber", nidNumber);
    formData.append("nidIssueDate", byId("driverNidIssueDate")?.value || "");
    formData.append("nidExpiryDate", byId("driverNidExpiryDate")?.value || "");

    formData.append("licenseNumber", licenseNumber);
    formData.append("licenseCategory", byId("driverLicenseCategory")?.value || "");
    formData.append("licenseAuthority", byId("driverLicenseAuthority")?.value.trim() || "");
    formData.append("licenseIssueDate", issueDate);
    formData.append("licenseExpiryDate", expiryDate);

    const nidFrontInput = byId("nidFrontInput");
    const nidBackInput = byId("nidBackInput");
    const licenseFrontInput = byId("licenseFrontInput");
    const licenseBackInput = byId("licenseBackInput");

    if (nidFrontInput?.files[0]) formData.append("nidFront", nidFrontInput.files[0]);
    if (nidBackInput?.files[0]) formData.append("nidBack", nidBackInput.files[0]);
    if (licenseFrontInput?.files[0]) formData.append("licenseFront", licenseFrontInput.files[0]);
    if (licenseBackInput?.files[0]) formData.append("licenseBack", licenseBackInput.files[0]);

    await runWithLoading(async () => {
      await api.updateDriverProfile(null, formData);
      showToast("Driver Profile & Documents saved successfully!", "success", "check");
      await loadDriverProfileSection();
    }, "Saving driver documents...");
  }

  async function renderProfilePage() {
    await runWithLoading(async () => {
      const res = await api.getMyProfile();
      const u = res.data;
      currentUser = mapProfileToCurrentUser(u);
      applyRoleVisibility();

      byId("profileFullName").value = u.full_name || "";
      byId("profileUsername").value = u.username || "";
      byId("profileRole").value = u.role ? u.role.charAt(0).toUpperCase() + u.role.slice(1) : "";
      byId("profileEmployeeId").value = u.employee_id || "-";
      if (byId("profileStatus")) byId("profileStatus").value = u.is_active ? "Active" : "Inactive";
      if (byId("profileCreatedAt")) byId("profileCreatedAt").value = formatDateTimeLocal(u.created_at);
      if (byId("profileLastLogin")) byId("profileLastLogin").value = formatDateTimeLocal(u.last_login_at);
      byId("profilePhone").value = u.phone || "";
      byId("profileEmail").value = u.email || "";

      if (u.profile_photo) {
        byId("profileAvatarPreview").src = u.profile_photo;
        byId("profileAvatarPreview").classList.remove("hidden");
        byId("profileAvatarPlaceholder").classList.add("hidden");
      } else {
        byId("profileAvatarPreview").src = "";
        byId("profileAvatarPreview").classList.add("hidden");
        byId("profileAvatarPlaceholder").classList.remove("hidden");
      }
      profilePhotoFile = null;
      profilePhotoRemoved = false;
      byId("changePasswordForm").reset();
      byId("profilePasswordError").textContent = "";

      await loadProfileAuditLogs();
      await loadDriverProfileSection();
    }, "Loading profile...");
  }

  async function handleProfileFormSubmit(e) {
    e.preventDefault();
    const fullName = byId("profileFullName").value.trim();
    if (!fullName) { showToast("Full name cannot be empty", "warning", "triangle-exclamation"); return; }

    const phone = byId("profilePhone").value.trim();
    if (!phone) {
      showToast("Phone number is mandatory", "warning", "triangle-exclamation");
      return;
    }
    if (!isValidBdPhone(phone)) {
      showToast("Please enter a valid Bangladesh mobile number (e.g. 01712345678 or +8801712345678)", "warning", "triangle-exclamation");
      return;
    }

    const formData = new FormData();
    formData.append("fullName", fullName);
    formData.append("phone", phone);
    formData.append("email", byId("profileEmail").value.trim());
    if (profilePhotoFile) formData.append("profilePhoto", profilePhotoFile, "photo.jpg");
    if (profilePhotoRemoved && !profilePhotoFile) formData.append("removeProfilePhoto", "true");

    await runWithLoading(async () => {
      const res = await api.updateMyProfile(formData);
      currentUser = mapProfileToCurrentUser(res.data);
      applyRoleVisibility();
      profilePhotoFile = null;
      profilePhotoRemoved = false;
      showToast("Profile updated successfully", "success", "check");
      await renderProfilePage();
    }, "Saving profile...");
  }

  async function handleChangePasswordSubmit(e) {
    e.preventDefault();
    byId("profilePasswordError").textContent = "";
    const current = byId("profileCurrentPassword").value;
    const next = byId("profileNewPassword").value;
    const confirmVal = byId("profileConfirmPassword").value;

    if (!current || !next || !confirmVal) {
      byId("profilePasswordError").textContent = "All password fields are required.";
      return;
    }
    if (next.length < 8) {
      byId("profilePasswordError").textContent = "New password must be at least 8 characters long.";
      return;
    }
    if (next === current) {
      byId("profilePasswordError").textContent = "New password cannot be the same as your current password.";
      return;
    }
    if (next !== confirmVal) {
      byId("profilePasswordError").textContent = "New password and confirmation do not match.";
      return;
    }

    await runWithLoading(async () => {
      await api.changeMyPassword(current, next, confirmVal);
      byId("changePasswordForm").reset();
      showToast("Password changed successfully", "success", "key");
      await loadProfileAuditLogs();
    }, "Changing password...");
  }

  function initProfilePhotoUpload() {
    byId("profilePhotoBtn").addEventListener("click", () => byId("profilePhotoInput").click());
    byId("profileAvatarBox").addEventListener("click", () => byId("profilePhotoInput").click());

    byId("profilePhotoInput").addEventListener("change", async () => {
      const file = byId("profilePhotoInput").files[0];
      if (!file) return;

      const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
      if (!allowedTypes.includes(file.type)) {
        showToast("Only JPG, JPEG, PNG, or WEBP images are allowed.", "warning", "triangle-exclamation");
        byId("profilePhotoInput").value = "";
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        showToast("Profile picture must be less than 5 MB.", "warning", "triangle-exclamation");
        byId("profilePhotoInput").value = "";
        return;
      }

      showLoading("Processing photo...");
      try {
        const { blob, previewUrl } = await readAndCompressImage(file);
        profilePhotoFile = blob;
        profilePhotoRemoved = false;
        byId("profileAvatarPreview").src = previewUrl;
        byId("profileAvatarPreview").classList.remove("hidden");
        byId("profileAvatarPlaceholder").classList.add("hidden");
      } catch (err) {
        showToast(err.message || "Could not read image file", "danger", "triangle-exclamation");
      } finally {
        hideLoading();
        byId("profilePhotoInput").value = "";
      }
    });

    byId("profilePhotoRemoveBtn").addEventListener("click", () => {
      profilePhotoFile = null;
      profilePhotoRemoved = true;
      byId("profileAvatarPreview").src = "";
      byId("profileAvatarPreview").classList.add("hidden");
      byId("profileAvatarPlaceholder").classList.remove("hidden");
    });
  }

  function initProfilePage() {
    initProfilePhotoUpload();
    byId("profileForm").addEventListener("submit", handleProfileFormSubmit);
    byId("changePasswordForm").addEventListener("submit", handleChangePasswordSubmit);
    const driverForm = byId("driverProfileForm");
    if (driverForm) driverForm.addEventListener("submit", handleDriverProfileSubmit);
  }

  /* ============================================================
     INIT
     Wires up everything implemented so far. Extended incrementally in
     each remaining part rather than deferred to one "final" block —
     that deferral was a mistake in planning Parts 1–2 (their init
     functions were defined but never actually called/wired until now).
     ============================================================ */
  document.addEventListener("DOMContentLoaded", () => {
    initDarkMode();
    initAuth();
    initNavigation();
    initForm();
    initCustomDropdownHandlers();
    initSettingsPage();
    initBrandingSettings();
    initConfirmModal();
    initPromptModal();
    initImageModal();
    initViewModal();
    initRecordsTableEvents();
    initSignatureModal();
    initExportButtons();
    initReports();
    initBackupRestore();
    initUserManagementPage();
    initProfilePage();
    initCameraModal();
    initMandatoryPhotoButtons();
    initNotifications();
    initOfflineAndPerformanceHandlers();
  });

  /* ============================================================
     SIGNATURE PAD (pure UI — canvas drawing, no API dependency)
     ============================================================ */
  function initSignatureModal() {
    sigPad.canvas = byId("signatureCanvas");
    sigPad.ctx = sigPad.canvas.getContext("2d");

    function getPos(e) {
      const rect = sigPad.canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return { x: clientX - rect.left, y: clientY - rect.top };
    }

    function start(e) {
      e.preventDefault();
      sigPad.drawing = true;
      const pos = getPos(e);
      sigPad.ctx.beginPath();
      sigPad.ctx.moveTo(pos.x, pos.y);
    }
    function move(e) {
      if (!sigPad.drawing) return;
      e.preventDefault();
      const pos = getPos(e);
      sigPad.ctx.lineTo(pos.x, pos.y);
      sigPad.ctx.strokeStyle = "#0f172a";
      sigPad.ctx.lineWidth = 2.4;
      sigPad.ctx.lineCap = "round";
      sigPad.ctx.stroke();
      sigPad.hasInk = true;
    }
    function end() { sigPad.drawing = false; }

    sigPad.canvas.addEventListener("mousedown", start);
    sigPad.canvas.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    sigPad.canvas.addEventListener("touchstart", start, { passive: false });
    sigPad.canvas.addEventListener("touchmove", move, { passive: false });
    sigPad.canvas.addEventListener("touchend", end);

    byId("clearSignBtn").addEventListener("click", clearSignaturePad);
    byId("cancelSignBtn").addEventListener("click", closeSignModal);
    byId("closeSignModal").addEventListener("click", closeSignModal);
    byId("saveSignBtn").addEventListener("click", saveSignature);

    window.addEventListener("resize", () => {
      if (!byId("signModal").classList.contains("hidden")) sizeSignatureCanvas();
    });
  }

  function sizeSignatureCanvas() {
    const canvas = sigPad.canvas;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    sigPad.ctx.scale(ratio, ratio);
    sigPad.ctx.fillStyle = "#ffffff";
    sigPad.ctx.fillRect(0, 0, rect.width, rect.height);
    sigPad.hasInk = false;
  }

  function clearSignaturePad() {
    const rect = sigPad.canvas.getBoundingClientRect();
    sigPad.ctx.clearRect(0, 0, sigPad.canvas.width, sigPad.canvas.height);
    sigPad.ctx.fillStyle = "#ffffff";
    sigPad.ctx.fillRect(0, 0, rect.width, rect.height);
    sigPad.hasInk = false;
  }

  function openSignModal(recordId) {
    const record = records.find((r) => r.id === recordId);
    if (!record) return;

    // Enforce the review-before-approve workflow: the sir must have
    // explicitly marked BOTH mandatory photos as reviewed (not just opened
    // the modal) before signing is allowed. Persisted server-side —
    // see markImageReviewed() / the derived reviewedForApproval.
    if (!record.reviewedForApproval) {
      showToast("Please mark both the Machine Display Photo and Money Receipt Photo as reviewed first", "warning", "triangle-exclamation");
      openViewModal(recordId);
      return;
    }

    pendingSignRecordId = recordId;

    // Populate the record summary + receipt photos so the sir can do a final
    // check without leaving the sign modal.
    byId("signSummary").innerHTML = `
      <div><strong>Driver</strong>${escapeHtml(record.driver)}</div>
      <div><strong>Vehicle</strong>${escapeHtml(record.vehicleNumber)}</div>
      <div><strong>Fuel</strong>${escapeHtml(record.fuelType)} — ${record.liters} L</div>
      <div><strong>Total Amount</strong>${formatMoney(record.totalAmount)}</div>
      <div><strong>Station</strong>${escapeHtml(record.stationName) || "-"}</div>
      <div><strong>Receipt No.</strong>${escapeHtml(record.receiptNumber) || "-"}</div>
    `;
    byId("signFuelReceiptImg").src = record.fuelReceiptImage || "";
    byId("signMoneyReceiptImg").src = record.moneyReceiptImage || "";
    // Pre-fill with whoever is actually signing in right now — any sir/admin
    // can approve any request, so there's no more "assigned sir" name to
    // default to. Saves the approver a step; they can still change it.
    byId("signApproverName").value = (currentUser && currentUser.fullName) || "";
    byId("signOfficeRemarks").value = record.officeRemarks || "";

    byId("signModal").classList.remove("hidden");
    setTimeout(() => { sizeSignatureCanvas(); }, 30);
  }
  function closeSignModal() {
    byId("signModal").classList.add("hidden");
    pendingSignRecordId = null;
  }

  // Converts the signature canvas to a PNG Blob and uploads it via
  // api.approveRecord() (multipart) alongside the approver name and office
  // remarks — replaces the old direct record mutation + LocalStorage save.
  function saveSignature() {
    if (!sigPad.hasInk) {
      showToast("Please draw a signature first", "warning", "triangle-exclamation");
      return;
    }
    const approverName = byId("signApproverName").value.trim();
    if (!approverName) {
      showToast("Please enter the approver's name", "warning", "triangle-exclamation");
      return;
    }
    const recordId = pendingSignRecordId;
    if (!recordId) { closeSignModal(); return; }
    const officeRemarks = byId("signOfficeRemarks").value.trim();

    runWithLoading(async () => {
      const blob = await new Promise((resolve) => sigPad.canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("Could not process the signature — please try drawing it again.");

      const formData = new FormData();
      formData.append("approverName", approverName);
      formData.append("officeRemarks", officeRemarks);
      formData.append("signatureImage", blob, "signature.png");

      const res = await api.approveRecord(recordId, formData);
      const idx = records.findIndex((r) => r.id === recordId);
      if (idx > -1) records[idx] = res.data;

      closeSignModal();
      refreshEverything();
      showToast(`Request ${recordId} approved & signed`, "success", "signature");
    }, "Saving signature...");
  }

  /* ============================================================
     FUEL RECEIVED STATUS
     ============================================================ */
  function setFuelReceived(id, status) {
    runWithLoading(async () => {
      const res = await api.setFuelStatus(id, status);
      const idx = records.findIndex((r) => r.id === id);
      if (idx > -1) records[idx] = res.data;
      refreshEverything();
      showToast(
        status === "received" ? `Fuel marked received for ${id}` : `Fuel marked NOT received for ${id}`,
        status === "received" ? "success" : "danger",
        status === "received" ? "gas-pump" : "triangle-exclamation"
      );
    });
  }

  /* ============================================================
     EXPORT: PDF / EXCEL / PRINT (Records page bulk export)
     Pure client-side rendering over filteredRecords() — unchanged.
     ============================================================ */
  function initExportButtons() {
    byId("exportPdfBtn").addEventListener("click", exportToPdf);
    byId("exportExcelBtn").addEventListener("click", exportToExcel);
  }

  // Loads an uploaded photo and re-encodes it as a JPEG data URL, regardless
  // of its original format — jsPDF's addImage() needs the actual image
  // bytes up front (autoTable's cell-drawing hook is synchronous, so this
  // can't happen lazily per-cell), and re-encoding through a canvas means we
  // never have to worry about which of JPEG/PNG/WEBP/GIF jsPDF can embed.
  function imageUrlToThumbnailDataUrl(url) {
    if (!url) return Promise.resolve(null);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d").drawImage(img, 0, 0);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = () => resolve(null); // photo missing/expired — table falls back to "No"
      img.src = url;
    });
  }

  // Draws a preloaded thumbnail into an autoTable cell, or leaves the
  // "No"/blank text alone if there's no photo to show.
  function drawPhotoThumbnailCell(doc, data, thumbnailsByRowIndex) {
    if (data.section !== "body") return;
    const dataUrl = thumbnailsByRowIndex[data.row.index];
    if (!dataUrl) return;
    const pad = 1;
    const size = Math.min(data.cell.width, data.cell.height) - pad * 2;
    doc.addImage(dataUrl, "JPEG", data.cell.x + pad, data.cell.y + pad, size, size);
  }

  async function exportToPdf() {
    const list = filteredRecords();
    if (!list.length) { showToast("No requests to export", "warning", "triangle-exclamation"); return; }
    await runWithLoading(async () => {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "landscape" });
      doc.setFontSize(14);
      doc.text(`${getOfficeName()} — Fuel Requests Report`, 14, 14);
      doc.setFontSize(9);
      doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 20);

      const machineThumbs = await Promise.all(list.map((r) => imageUrlToThumbnailDataUrl(r.fuelReceiptImage)));
      const moneyThumbs = await Promise.all(list.map((r) => imageUrlToThumbnailDataUrl(r.moneyReceiptImage)));

      doc.autoTable({
        startY: 26,
        head: [["ID", "Date", "Driver", "Vehicle", "Station", "Fuel", "Liters", "Total", "Machine Photo", "Money Receipt", "Approval", "Fuel Status"]],
        body: list.map((r, i) => [
          r.id, formatDateDisplay(r.date), r.driver, r.vehicleNumber, r.stationName || "-", r.fuelType,
          r.liters, formatMoney(r.totalAmount),
          machineThumbs[i] ? "" : "No", moneyThumbs[i] ? "" : "No",
          r.approvalStatus === "approved" ? "Approved" : "Pending",
          r.fuelReceived === "received" ? "Received" : r.fuelReceived === "not_received" ? "Not Received" : "Not Set",
        ]),
        styles: { fontSize: 8, minCellHeight: 16, valign: "middle" },
        headStyles: { fillColor: [37, 99, 235] },
        columnStyles: { 8: { cellWidth: 18 }, 9: { cellWidth: 18 } },
        didDrawCell: (data) => {
          if (data.column.index === 8) drawPhotoThumbnailCell(doc, data, machineThumbs);
          else if (data.column.index === 9) drawPhotoThumbnailCell(doc, data, moneyThumbs);
        },
      });

      doc.save(`fuel-requests-${todayISO()}.pdf`);
      showToast("PDF exported", "success", "file-pdf");
    }, "Generating PDF...");
  }

  function exportToExcel() {
    const list = filteredRecords();
    if (!list.length) { showToast("No requests to export", "warning", "triangle-exclamation"); return; }
    runWithLoading(() => {
      const rows = list.map((r) => ({
        ID: r.id, Date: r.date, Time: r.time, Driver: r.driver,
        Vehicle: r.vehicleNumber, "Station Name": r.stationName || "", "Odometer (km)": r.odometer != null ? r.odometer : "",
        "Fuel Type": r.fuelType, Liters: r.liters,
        "Price/Liter": r.pricePerLiter, "Total Amount": r.totalAmount, "Receipt No": r.receiptNumber,
        "Machine Photo Uploaded": r.fuelReceiptImage ? "Yes" : "No",
        "Money Receipt Uploaded": r.moneyReceiptImage ? "Yes" : "No",
        "Approval Status": r.approvalStatus, "Approved By": r.approvedBy || "", "Approval Date/Time": formatTimestamp(r.signedAt),
        "Fuel Received": r.fuelReceived || "not set", Remarks: r.remarks, "Office Remarks": r.officeRemarks || "",
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Fuel Records");
      XLSX.writeFile(wb, `fuel-records-${todayISO()}.xlsx`);
      showToast("Excel file exported", "success", "file-excel");
    }, "Generating Excel file...");
  }

  function printRecord(id) {
    const r = records.find((x) => x.id === id);
    if (!r) return;
    const printArea = byId("printArea");
    printArea.innerHTML = `
      <div style="font-family:Arial,sans-serif;color:#0f172a;">
        <h2 style="margin-bottom:2px;">${escapeHtml(getOfficeName())}</h2>
        <p style="margin-top:0;color:#555;">Fuel Request — ${r.id}</p>
        <hr />
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tr><td style="padding:6px;font-weight:bold;">Date / Time</td><td style="padding:6px;">${formatDateDisplay(r.date)}, ${r.time}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;">Driver</td><td style="padding:6px;">${escapeHtml(r.driver)}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;">Vehicle Number</td><td style="padding:6px;">${escapeHtml(r.vehicleNumber)}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;">Fuel Station</td><td style="padding:6px;">${escapeHtml(r.stationName) || "-"}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;">Odometer / KM</td><td style="padding:6px;">${r.odometer != null && r.odometer !== "" ? r.odometer + " km" : "-"}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;">Fuel Type</td><td style="padding:6px;">${escapeHtml(r.fuelType)}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;">Quantity</td><td style="padding:6px;">${r.liters} Liters</td></tr>
          <tr><td style="padding:6px;font-weight:bold;">Price / Liter</td><td style="padding:6px;">${formatMoney(r.pricePerLiter)}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;">Total Amount</td><td style="padding:6px;">${formatMoney(r.totalAmount)}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;">Receipt No</td><td style="padding:6px;">${escapeHtml(r.receiptNumber) || "-"}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;">Machine Photo Uploaded</td><td style="padding:6px;">${r.fuelReceiptImage ? "Yes" : "No"}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;">Money Receipt Uploaded</td><td style="padding:6px;">${r.moneyReceiptImage ? "Yes" : "No"}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;">Approval</td><td style="padding:6px;">${r.approvalStatus === "approved" ? "Approved" : "Pending"}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;">Approved By</td><td style="padding:6px;">${escapeHtml(r.approvedBy) || "-"}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;">Approval Date/Time</td><td style="padding:6px;">${formatTimestamp(r.signedAt)}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;">Fuel Received</td><td style="padding:6px;">${r.fuelReceived === "received" ? "Received" : r.fuelReceived === "not_received" ? "Not Received" : "Not Set"}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;">Driver's Remarks</td><td style="padding:6px;">${escapeHtml(r.remarks) || "-"}</td></tr>
          <tr><td style="padding:6px;font-weight:bold;">Office Remarks</td><td style="padding:6px;">${escapeHtml(r.officeRemarks) || "-"}</td></tr>
        </table>
        <div style="display:flex;gap:16px;margin-top:16px;flex-wrap:wrap;">
          ${r.fuelReceiptImage ? `<div><p style="font-size:12px;font-weight:bold;">Fuel Machine Display Photo</p><img src="${r.fuelReceiptImage}" style="width:220px;border:1px solid #ccc;" /></div>` : ""}
          ${r.moneyReceiptImage ? `<div><p style="font-size:12px;font-weight:bold;">Money Receipt Photo</p><img src="${r.moneyReceiptImage}" style="width:220px;border:1px solid #ccc;" /></div>` : ""}
          ${r.driverPhotoImage ? `<div><p style="font-size:12px;font-weight:bold;">Driver Photo</p><img src="${r.driverPhotoImage}" style="width:180px;border:1px solid #ccc;" /></div>` : ""}
          ${r.vehiclePhotoImage ? `<div><p style="font-size:12px;font-weight:bold;">Vehicle Photo</p><img src="${r.vehiclePhotoImage}" style="width:180px;border:1px solid #ccc;" /></div>` : ""}
          ${r.signature ? `<div><p style="font-size:12px;font-weight:bold;">Signature</p><img src="${r.signature}" style="width:180px;border:1px solid #ccc;background:#fff;" /></div>` : ""}
        </div>
      </div>
    `;

    // Calling window.print() immediately after setting innerHTML can open
    // the print dialog before the photo <img> tags have actually finished
    // downloading — on a slow connection or an uncached image, that prints
    // a blank/broken photo (looking to the user like printing "didn't
    // work"). Wait for every photo to actually load (or fail) first.
    const images = Array.from(printArea.querySelectorAll("img"));
    const allImagesSettled = Promise.all(images.map((img) => {
      if (img.complete) return Promise.resolve();
      return new Promise((resolve) => {
        img.onload = resolve;
        img.onerror = resolve; // don't block printing forever over one broken photo
      });
    }));

    allImagesSettled.then(() => window.print());
  }

  /* ============================================================
     REPORTS (monthly / date range / driver / vehicle / sir / station)
     Aggregation now happens server-side, directly in MySQL (GET
     /api/reports uses GROUP BY) — getReportData() just calls it. The
     rendering functions below are otherwise unchanged from the
     client-computed version, since the response shape matches exactly.
     ============================================================ */
  // Unique, non-empty values for a record field — used to populate the
  // vehicle/station report filter dropdowns from whatever data actually exists.
  function uniqueValues(field) {
    return Array.from(new Set(records.map((r) => r[field]).filter(Boolean))).sort();
  }

  // Reads the current report type + its filter inputs into query params
  // for GET /api/reports.
  function getReportQueryParams() {
    const type = byId("reportType").value;
    const params = { type };
    if (type === "range") {
      if (byId("reportFrom").value) params.from = byId("reportFrom").value;
      if (byId("reportTo").value) params.to = byId("reportTo").value;
    } else if (type === "driver") {
      if (byId("reportDriverSelect").value) params.driver = byId("reportDriverSelect").value;
    } else if (type === "vehicle") {
      if (byId("reportVehicleSelect").value) params.vehicle = byId("reportVehicleSelect").value;
    } else if (type === "station") {
      if (byId("reportStationSelect").value) params.station = byId("reportStationSelect").value;
    } else {
      params.month = byId("reportMonth").value || todayISO().slice(0, 7);
    }
    return params;
  }

  // Returns { label, filename, totalRecords, totalLiters, totalCost,
  // byDriver, byFuelType, matched } — computed server-side.
  async function getReportData() {
    const res = await api.getReport(getReportQueryParams());
    return res.data;
  }

  function updateReportFilterVisibility() {
    const type = byId("reportType").value;
    $all(".report-filter").forEach((el) => el.classList.toggle("hidden", el.dataset.for !== type));
  }

  function populateReportFilterOptions() {
    byId("reportDriverSelect").innerHTML = '<option value="">All Drivers</option>' +
      drivers.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
    byId("reportVehicleSelect").innerHTML = '<option value="">All Vehicles</option>' +
      uniqueValues("vehicleNumber").map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    byId("reportStationSelect").innerHTML = '<option value="">All Stations</option>' +
      uniqueValues("stationName").map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  }

  // Renders a {records, liters, cost}-by-key breakdown into a table + its empty state.
  function renderBreakdownTable(tableId, emptyId, rows) {
    const tbody = $(`#${tableId} tbody`);
    byId(emptyId).classList.toggle("hidden", rows.length > 0);
    byId(tableId).classList.toggle("hidden", rows.length === 0);
    tbody.innerHTML = rows.map(([key, d]) => `
      <tr>
        <td>${escapeHtml(key)}</td>
        <td>${d.records}</td>
        <td>${d.liters.toLocaleString("en-US", { maximumFractionDigits: 2 })} L</td>
        <td>${formatMoney(d.cost)}</td>
      </tr>
    `).join("");
  }

  async function renderReport() {
    populateReportFilterOptions();
    let data;
    try {
      data = await getReportData();
    } catch (err) {
      handleApiError(err);
      return;
    }

    byId("reportStatRecords").textContent = data.matched.length;
    byId("reportStatLiters").textContent = data.totalLiters.toLocaleString("en-US", { maximumFractionDigits: 2 });
    byId("reportStatCost").textContent = formatMoney(data.totalCost);

    renderBreakdownTable("reportDriverTable", "reportDriverEmpty", Object.entries(data.byDriver));
    renderBreakdownTable("reportFuelTable", "reportFuelEmpty", Object.entries(data.byFuelType));

    const recordsTbody = $("#reportRecordsTable tbody");
    const reportCardsEl = byId("reportRecordsMobileCards");
    byId("reportRecordsEmpty").classList.toggle("hidden", data.matched.length > 0);
    $("#reportRecordsTable").classList.toggle("hidden", data.matched.length === 0);

    if (!data.matched.length) {
      recordsTbody.innerHTML = "";
      if (reportCardsEl) reportCardsEl.innerHTML = "";
    } else {
      recordsTbody.innerHTML = data.matched.map((r) => `
        <tr>
          <td><strong>${r.id}</strong></td>
          <td>${formatDateDisplay(r.date)}</td>
          <td>${escapeHtml(r.driver)}</td>
          <td>${escapeHtml(r.vehicleNumber)}</td>
          <td>${escapeHtml(r.stationName) || "-"}</td>
          <td>${escapeHtml(r.fuelType)}</td>
          <td>${r.liters} L</td>
          <td>${formatMoney(r.totalAmount)}</td>
          <td>${yesNoBadge(r.hasMachinePhoto)}</td>
          <td>${yesNoBadge(r.hasMoneyReceipt)}</td>
          <td>${statusBadgeHtml(r)}</td>
        </tr>
      `).join("");

      if (reportCardsEl) {
        reportCardsEl.innerHTML = data.matched.map((r) => `
          <div class="mobile-card" data-id="${r.id}">
            <div class="mobile-card-header">
              <div class="mobile-card-title">
                <strong>${r.id}</strong>
                <span style="font-size:12px;color:var(--text-muted);font-weight:normal;margin-left:6px;">${formatDateDisplay(r.date)}</span>
              </div>
              ${statusBadgeHtml(r)}
            </div>
            <div class="mobile-card-body">
              <div class="mobile-card-row">
                <span class="mobile-card-label"><i class="fa-solid fa-user"></i> Driver</span>
                <span class="mobile-card-val">${escapeHtml(r.driver)}</span>
              </div>
              <div class="mobile-card-row">
                <span class="mobile-card-label"><i class="fa-solid fa-car"></i> Vehicle</span>
                <span class="mobile-card-val">${escapeHtml(r.vehicleNumber)}</span>
              </div>
              <div class="mobile-card-row">
                <span class="mobile-card-label"><i class="fa-solid fa-gas-pump"></i> Fuel</span>
                <span class="mobile-card-val">${escapeHtml(r.fuelType)} (${r.liters} L)</span>
              </div>
              <div class="mobile-card-row">
                <span class="mobile-card-label"><i class="fa-solid fa-money-bill"></i> Total</span>
                <span class="mobile-card-val" style="color:var(--primary);font-size:15px;font-weight:800;">${formatMoney(r.totalAmount)}</span>
              </div>
            </div>
          </div>`).join("");
      }
    }
  }

  async function printReport() {
    let data;
    try {
      data = await getReportData();
    } catch (err) {
      handleApiError(err);
      return;
    }
    const printArea = byId("printArea");
    const logoUrl = brandingSettings.companyLogo || logoPath || "/logo/NGO_logo_monogram.webp";
    printArea.innerHTML = `
      <div style="font-family:Arial,sans-serif;color:#0f172a;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;border-bottom:2px solid #0099F1;padding-bottom:10px;">
          <div style="display:flex;align-items:center;gap:16px;">
            <img src="${logoUrl}" style="height:80px;width:auto;object-fit:contain;" alt="ATMABISWAS Logo" />
            <div>
              <h1 style="margin:0;font-size:22px;color:#0099F1;font-weight:800;">${escapeHtml(brandingSettings.companyName || "ATMABISWAS")}</h1>
              <p style="margin:2px 0 0;font-size:14px;font-weight:700;color:#334155;">${escapeHtml(brandingSettings.shortName || "ATMABISWAS Fuel")}</p>
              <p style="margin:2px 0 0;font-size:12px;color:#64748b;">${escapeHtml(getOfficeName())}</p>
            </div>
          </div>
          <div style="text-align:right;font-size:12px;color:#64748b;">
            <strong>Fuel Request Report</strong><br />
            <span>${formatDateDisplay(todayISO())}</span>
          </div>
        </div>
        <p style="margin-top:0;color:#555;">${escapeHtml(data.label)}</p>
        <hr />
        <p><strong>Total Records:</strong> ${data.matched.length} &nbsp; | &nbsp;
           <strong>Total Liters:</strong> ${data.totalLiters.toLocaleString("en-US", { maximumFractionDigits: 2 })} L &nbsp; | &nbsp;
           <strong>Total Cost:</strong> ${formatMoney(data.totalCost)}</p>

        <h3 style="margin-top:20px;">Driver-wise Totals</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tr style="background:#f1f5f9;"><th style="text-align:left;padding:6px;">Driver</th><th style="text-align:left;padding:6px;">Records</th><th style="text-align:left;padding:6px;">Liters</th><th style="text-align:left;padding:6px;">Total Cost</th></tr>
          ${Object.entries(data.byDriver).map(([driver, d]) => `
            <tr><td style="padding:6px;">${escapeHtml(driver)}</td><td style="padding:6px;">${d.records}</td><td style="padding:6px;">${d.liters.toFixed(2)} L</td><td style="padding:6px;">${formatMoney(d.cost)}</td></tr>
          `).join("") || `<tr><td style="padding:6px;" colspan="4">No matching records</td></tr>`}
        </table>

        <h3 style="margin-top:20px;">Fuel Type Summary</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tr style="background:#f1f5f9;"><th style="text-align:left;padding:6px;">Fuel Type</th><th style="text-align:left;padding:6px;">Records</th><th style="text-align:left;padding:6px;">Liters</th><th style="text-align:left;padding:6px;">Total Cost</th></tr>
          ${Object.entries(data.byFuelType).map(([fuelType, d]) => `
            <tr><td style="padding:6px;">${escapeHtml(fuelType)}</td><td style="padding:6px;">${d.records}</td><td style="padding:6px;">${d.liters.toFixed(2)} L</td><td style="padding:6px;">${formatMoney(d.cost)}</td></tr>
          `).join("") || `<tr><td style="padding:6px;" colspan="4">No matching records</td></tr>`}
        </table>

        <h3 style="margin-top:20px;">Matching Records</h3>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <tr style="background:#f1f5f9;">
            <th style="text-align:left;padding:6px;">ID</th><th style="text-align:left;padding:6px;">Date</th>
            <th style="text-align:left;padding:6px;">Driver</th><th style="text-align:left;padding:6px;">Vehicle</th>
            <th style="text-align:left;padding:6px;">Machine Photo</th><th style="text-align:left;padding:6px;">Money Receipt</th>
            <th style="text-align:left;padding:6px;">Status</th>
          </tr>
          ${data.matched.map((r) => `
            <tr>
              <td style="padding:6px;">${escapeHtml(r.id)}</td>
              <td style="padding:6px;">${formatDateDisplay(r.date)}</td>
              <td style="padding:6px;">${escapeHtml(r.driver)}</td>
              <td style="padding:6px;">${escapeHtml(r.vehicleNumber)}</td>
              <td style="padding:6px;">${r.hasMachinePhoto ? "Yes" : "No"}</td>
              <td style="padding:6px;">${r.hasMoneyReceipt ? "Yes" : "No"}</td>
              <td style="padding:6px;">${r.approvalStatus === "approved" ? "Approved" : r.isDraft ? "Draft" : "Pending"}</td>
            </tr>
          `).join("") || `<tr><td style="padding:6px;" colspan="7">No matching records</td></tr>`}
        </table>
      </div>
    `;
    window.print();
  }

  function exportReportPdf() {
    runWithLoading(async () => {
      const data = await getReportData();
      if (!data.matched.length) { showToast("No requests match this report", "warning", "triangle-exclamation"); return; }

      const { jsPDF } = window.jspdf;
      const doc = new jsPDF();
      doc.setFontSize(14);
      doc.text(getOfficeName(), 14, 14);
      doc.setFontSize(10);
      doc.text(data.label, 14, 21);
      doc.setFontSize(9);
      doc.text(`Records: ${data.matched.length}   Liters: ${data.totalLiters.toFixed(2)}   Total: ${formatMoney(data.totalCost)}`, 14, 27);

      doc.autoTable({
        startY: 33,
        head: [["Driver", "Records", "Liters", "Total Cost"]],
        body: Object.entries(data.byDriver).map(([driver, d]) => [driver, d.records, d.liters.toFixed(2), formatMoney(d.cost)]),
        styles: { fontSize: 9 },
        headStyles: { fillColor: [37, 99, 235] },
      });

      doc.autoTable({
        startY: doc.lastAutoTable.finalY + 10,
        head: [["Fuel Type", "Records", "Liters", "Total Cost"]],
        body: Object.entries(data.byFuelType).map(([fuelType, d]) => [fuelType, d.records, d.liters.toFixed(2), formatMoney(d.cost)]),
        styles: { fontSize: 9 },
        headStyles: { fillColor: [37, 99, 235] },
      });

      const machineThumbs = await Promise.all(data.matched.map((r) => imageUrlToThumbnailDataUrl(r.fuelReceiptImage)));
      const moneyThumbs = await Promise.all(data.matched.map((r) => imageUrlToThumbnailDataUrl(r.moneyReceiptImage)));

      doc.autoTable({
        startY: doc.lastAutoTable.finalY + 10,
        head: [["ID", "Date", "Driver", "Vehicle", "Machine Photo", "Money Receipt", "Status"]],
        body: data.matched.map((r, i) => [
          r.id, formatDateDisplay(r.date), r.driver, r.vehicleNumber,
          machineThumbs[i] ? "" : "No", moneyThumbs[i] ? "" : "No",
          r.approvalStatus === "approved" ? "Approved" : r.isDraft ? "Draft" : "Pending",
        ]),
        styles: { fontSize: 8, minCellHeight: 16, valign: "middle" },
        headStyles: { fillColor: [37, 99, 235] },
        columnStyles: { 4: { cellWidth: 18 }, 5: { cellWidth: 18 } },
        didDrawCell: (data2) => {
          if (data2.column.index === 4) drawPhotoThumbnailCell(doc, data2, machineThumbs);
          else if (data2.column.index === 5) drawPhotoThumbnailCell(doc, data2, moneyThumbs);
        },
      });

      doc.save(`${data.filename}.pdf`);
      showToast("Report PDF exported", "success", "file-pdf");
    }, "Generating PDF...");
  }

  function exportReportExcel() {
    runWithLoading(async () => {
      const data = await getReportData();
      if (!data.matched.length) { showToast("No requests match this report", "warning", "triangle-exclamation"); return; }

      const summarySheet = XLSX.utils.json_to_sheet([{
        Report: data.label, "Total Records": data.matched.length,
        "Total Liters": data.totalLiters, "Total Cost": data.totalCost,
      }]);
      const driverSheet = XLSX.utils.json_to_sheet(
        Object.entries(data.byDriver).map(([driver, d]) => ({ Driver: driver, Records: d.records, Liters: d.liters, "Total Cost": d.cost }))
      );
      const fuelSheet = XLSX.utils.json_to_sheet(
        Object.entries(data.byFuelType).map(([fuelType, d]) => ({ "Fuel Type": fuelType, Records: d.records, Liters: d.liters, "Total Cost": d.cost }))
      );
      const recordsSheet = XLSX.utils.json_to_sheet(
        data.matched.map((r) => ({
          ID: r.id, Date: r.date, Driver: r.driver, Vehicle: r.vehicleNumber,
          Station: r.stationName || "", "Fuel Type": r.fuelType, Liters: r.liters, "Total Amount": r.totalAmount,
          "Machine Photo Uploaded": r.hasMachinePhoto ? "Yes" : "No",
          "Money Receipt Uploaded": r.hasMoneyReceipt ? "Yes" : "No",
        }))
      );

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");
      XLSX.utils.book_append_sheet(wb, driverSheet, "By Driver");
      XLSX.utils.book_append_sheet(wb, fuelSheet, "By Fuel Type");
      XLSX.utils.book_append_sheet(wb, recordsSheet, "Records");
      XLSX.writeFile(wb, `${data.filename}.xlsx`);
      showToast("Report Excel exported", "success", "file-excel");
    }, "Generating Excel file...");
  }

  function initReports() {
    byId("reportMonth").value = todayISO().slice(0, 7);
    updateReportFilterVisibility();

    byId("reportType").addEventListener("change", () => {
      updateReportFilterVisibility();
      renderReport();
    });
    ["reportMonth", "reportFrom", "reportTo", "reportDriverSelect", "reportVehicleSelect", "reportStationSelect"]
      .forEach((id) => byId(id).addEventListener("change", renderReport));

    byId("generateReportBtn").addEventListener("click", renderReport);
    byId("printReportBtn").addEventListener("click", printReport);
    byId("reportPdfBtn").addEventListener("click", exportReportPdf);
    byId("reportExcelBtn").addEventListener("click", exportReportExcel);
  }

  /* ============================================================
     BACKUP & RESTORE (JSON) — now a full round-trip to the server
     instead of reading/writing LocalStorage directly. Note the
     downloaded file is much smaller than the old LocalStorage-era
     backups: images are stored as file paths now, not embedded
     Base64 blobs.
     ============================================================ */
  function initBackupRestore() {
    byId("backupJsonBtn").addEventListener("click", () => {
      runWithLoading(async () => {
        const res = await api.getBackup();
        const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `fsms-backup-${todayISO()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast("Backup downloaded", "success", "download");
      }, "Preparing backup...");
    });

    byId("restoreJsonBtn").addEventListener("click", () => byId("restoreJsonInput").click());

    byId("restoreJsonInput").addEventListener("change", () => {
      const file = byId("restoreJsonInput").files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        let data;
        try {
          data = JSON.parse(e.target.result);
        } catch (err) {
          showToast("Invalid backup file — not valid JSON", "danger", "triangle-exclamation");
          byId("restoreJsonInput").value = "";
          return;
        }
        if (!data || !Array.isArray(data.records) || !Array.isArray(data.drivers) || !Array.isArray(data.sirs)) {
          showToast("Invalid backup file — missing required data", "danger", "triangle-exclamation");
          byId("restoreJsonInput").value = "";
          return;
        }

        openConfirm(
          "Restore from Backup",
          `This will REPLACE all current records (${records.length}), drivers, sirs, fuel types, and stations in the database with the contents of "${file.name}" (${data.records.length} records). This cannot be undone. Continue?`,
          async () => {
            await runWithLoading(async () => {
              await api.restoreBackup(data);
              await loadAllData();
              refreshEverything();
              showToast("Backup restored successfully", "success", "check");
            }, "Restoring backup...");
            byId("restoreJsonInput").value = "";
          },
          () => { byId("restoreJsonInput").value = ""; }
        );
      };
      reader.onerror = () => {
        showToast("Could not read the backup file", "danger", "triangle-exclamation");
        byId("restoreJsonInput").value = "";
      };
      reader.readAsText(file);
    });
  }

  /* ============================================================
     NOTIFICATION SYSTEM
     ============================================================ */

  let _notifPollInterval = null;
  let _notifLastCount = 0;
  let _notifDropdownOpen = false;
  let _notifAllData = [];           // cached list for history page
  let _notifHistoryFilters = {};

  // --- Icon map per notification type ---
  function _notifIcon(type) {
    const icons = {
      success: "fa-circle-check",
      warning: "fa-triangle-exclamation",
      error: "fa-circle-xmark",
      info: "fa-circle-info",
      approval: "fa-thumbs-up",
      rejection: "fa-thumbs-down",
      reminder: "fa-clock",
      system: "fa-gear",
    };
    return icons[type] || "fa-bell";
  }

  function _notifTimeSince(dateStr) {
    if (!dateStr) return "";
    const diff = Date.now() - new Date(dateStr).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  // --- Bell Polling ---
  function startNotifPolling() {
    stopNotifPolling();
    _pollNotifNow();
    _notifPollInterval = setInterval(() => {
      if (document.visibilityState === "visible" && currentUser) _pollNotifNow();
    }, 20000);
  }

  function stopNotifPolling() {
    if (_notifPollInterval) { clearInterval(_notifPollInterval); _notifPollInterval = null; }
  }

  async function _pollNotifNow() {
    if (!currentUser) return;
    try {
      const res = await api.getUnreadNotifCount();
      const count = res.unreadCount ?? 0;
      _updateNotifBadge(count);

      // If count increased since last poll → toast alert (browser preference)
      if (count > _notifLastCount && _notifLastCount >= 0) {
        const newCount = count - _notifLastCount;
        showToast(`You have ${newCount} new notification${newCount > 1 ? "s" : ""}`, "info", "bell");
      }
      _notifLastCount = count;

      // Refresh the dropdown list if it's open
      if (_notifDropdownOpen) await _loadNotifDropdown();
    } catch (_) { /* silent */ }
  }

  function _updateNotifBadge(count) {
    const badge = byId("notifBadgeCount");
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? "99+" : count;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  // --- Dropdown ---
  async function _loadNotifDropdown() {
    const list = byId("notifDropdownList");
    if (!list) return;
    try {
      const res = await api.getNotifications({ limit: 8 });
      const items = res.data?.notifications || [];
      if (!items.length) {
        list.innerHTML = `<div class="notif-empty"><i class="fa-solid fa-bell-slash"></i><span>No notifications yet</span></div>`;
        return;
      }
      list.innerHTML = items.map((n) => _buildNotifDropdownItem(n)).join("");
      list.querySelectorAll(".notif-item").forEach((el) => {
        el.addEventListener("click", () => _handleNotifClick(el, parseInt(el.dataset.id), el.dataset.record));
      });
    } catch (_) {
      list.innerHTML = `<div class="notif-empty"><i class="fa-solid fa-wifi-slash"></i><span>Could not load notifications</span></div>`;
    }
  }

  function _buildNotifDropdownItem(n) {
    const typeClass = n.type || "info";
    const unreadClass = !n.is_read ? "is-unread" : "";
    return `
      <div class="notif-item ${unreadClass}" data-id="${n.id}" data-record="${escapeHtml(n.related_record_code || "")}">
        <div class="notif-icon-box ${typeClass}">
          <i class="fa-solid ${_notifIcon(n.type)}"></i>
        </div>
        <div class="notif-content">
          <div class="notif-title">
            <span>${escapeHtml(n.title)}</span>
            ${!n.is_read ? '<span style="width:8px;height:8px;border-radius:50%;background:var(--primary);display:inline-block;"></span>' : ""}
          </div>
          <div class="notif-message">${escapeHtml(n.message)}</div>
          <div class="notif-time"><i class="fa-regular fa-clock"></i> ${_notifTimeSince(n.created_at)}${n.related_record_code ? ` · ${escapeHtml(n.related_record_code)}` : ""}</div>
        </div>
      </div>`;
  }

  async function _handleNotifClick(el, id, recordCode) {
    // Mark as read
    if (el.classList.contains("is-unread")) {
      try {
        await api.markNotifRead(id);
        el.classList.remove("is-unread");
        _notifLastCount = Math.max(0, _notifLastCount - 1);
        _updateNotifBadge(_notifLastCount);
      } catch (_) {}
    }
    // Navigate to record if applicable
    if (recordCode) {
      _closeNotifDropdown();
      goToPage("records");
    }
  }

  function _toggleNotifDropdown() {
    const dropdown = byId("notifDropdown");
    if (!dropdown) return;
    _notifDropdownOpen = !_notifDropdownOpen;
    dropdown.classList.toggle("hidden", !_notifDropdownOpen);
    if (_notifDropdownOpen) _loadNotifDropdown();
  }

  function _closeNotifDropdown() {
    _notifDropdownOpen = false;
    byId("notifDropdown")?.classList.add("hidden");
  }

  // --- Notification History Page ---
  async function renderNotifHistory() {
    const container = byId("notifHistoryContainer");
    if (!container) return;
    container.innerHTML = `<p class="text-center text-muted">Loading notifications...</p>`;
    try {
      const params = { limit: 100 };
      if (_notifHistoryFilters.type) params.type = _notifHistoryFilters.type;
      if (_notifHistoryFilters.is_read !== undefined && _notifHistoryFilters.is_read !== "") params.is_read = _notifHistoryFilters.is_read;
      const res = await api.getNotifications(params);
      _notifAllData = res.data?.notifications || [];
      _renderNotifHistoryList();
    } catch (_) {
      container.innerHTML = `<p class="text-center text-muted">Failed to load notifications.</p>`;
    }
  }

  function _renderNotifHistoryList() {
    const container = byId("notifHistoryContainer");
    if (!container) return;
    const query = (byId("notifSearch")?.value || "").toLowerCase();
    let items = _notifAllData;
    if (query) {
      items = items.filter((n) =>
        n.title.toLowerCase().includes(query) ||
        n.message.toLowerCase().includes(query) ||
        (n.related_record_code || "").toLowerCase().includes(query)
      );
    }
    if (!items.length) {
      container.innerHTML = `<div class="notif-empty"><i class="fa-solid fa-bell-slash"></i><span>No notifications found</span></div>`;
      return;
    }
    container.innerHTML = items.map((n) => {
      const typeClass = n.type || "info";
      const unreadClass = !n.is_read ? "is-unread" : "";
      return `
        <div class="notif-history-card ${unreadClass}" data-id="${n.id}" data-record="${escapeHtml(n.related_record_code || "")}">
          <div class="notif-icon-box ${typeClass}" style="width:44px;height:44px;font-size:18px;border-radius:12px;flex-shrink:0;">
            <i class="fa-solid ${_notifIcon(n.type)}"></i>
          </div>
          <div class="notif-content" style="flex:1;min-width:0;">
            <div class="notif-title" style="font-size:14px;margin-bottom:4px;">
              <span>${escapeHtml(n.title)}</span>
              ${!n.is_read ? '<span class="badge badge-primary" style="font-size:10px;padding:2px 8px;">Unread</span>' : '<span class="badge badge-neutral" style="font-size:10px;padding:2px 8px;">Read</span>'}
            </div>
            <div class="notif-message" style="font-size:13px;">${escapeHtml(n.message)}</div>
            <div class="notif-time" style="margin-top:6px;font-size:12px;">
              <i class="fa-regular fa-clock"></i> ${_notifTimeSince(n.created_at)}
              ${n.related_record_code ? `<span style="margin-left:10px;"><i class="fa-solid fa-file-lines"></i> <a href="#" class="notif-open-record" data-record="${escapeHtml(n.related_record_code)}" style="color:var(--primary);font-weight:600;">${escapeHtml(n.related_record_code)}</a></span>` : ""}
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;align-items:flex-start;">
            ${!n.is_read ? `<button class="btn btn-outline btn-sm notif-mark-read-btn" data-id="${n.id}" title="Mark as read"><i class="fa-solid fa-check"></i></button>` : ""}
            <button class="btn btn-ghost btn-sm notif-delete-btn" data-id="${n.id}" title="Delete notification" style="color:var(--danger);"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>`;
    }).join("");

    // Bind events
    container.querySelectorAll(".notif-mark-read-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id);
        try {
          await api.markNotifRead(id);
          const n = _notifAllData.find((x) => x.id === id);
          if (n) n.is_read = 1;
          _renderNotifHistoryList();
          _notifLastCount = Math.max(0, _notifLastCount - 1);
          _updateNotifBadge(_notifLastCount);
        } catch (err) { handleApiError(err); }
      });
    });

    container.querySelectorAll(".notif-delete-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id);
        try {
          await api.deleteNotif(id);
          _notifAllData = _notifAllData.filter((x) => x.id !== id);
          _renderNotifHistoryList();
          showToast("Notification deleted", "success", "trash");
        } catch (err) { handleApiError(err); }
      });
    });

    container.querySelectorAll(".notif-open-record").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        goToPage("records");
      });
    });
  }

  // --- Notification Preferences ---
  async function _loadNotifPreferences() {
    try {
      const res = await api.getNotifPreferences();
      const prefs = res.data || {};
      if (byId("prefInApp")) byId("prefInApp").checked = prefs.in_app !== false;
      if (byId("prefBrowser")) byId("prefBrowser").checked = prefs.browser_alerts !== false;
    } catch (_) {}
  }

  async function _saveNotifPreferences() {
    const prefs = {
      in_app: byId("prefInApp")?.checked ? 1 : 0,
      browser_alerts: byId("prefBrowser")?.checked ? 1 : 0,
    };
    try {
      await api.updateNotifPreferences(prefs);
      byId("notifPrefModal")?.classList.add("hidden");
      showToast("Notification preferences saved", "success", "check");
    } catch (err) { handleApiError(err); }
  }

  // --- Init Notifications ---
  function initNotifications() {
    // Bell button toggle
    byId("notifBellBtn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      _toggleNotifDropdown();
    });

    // Close dropdown on outside click
    document.addEventListener("click", (e) => {
      if (_notifDropdownOpen && !e.target.closest(".notif-bell-wrapper")) {
        _closeNotifDropdown();
      }
    });

    // Mark all read
    byId("notifMarkAllReadBtn")?.addEventListener("click", async () => {
      try {
        await api.markAllNotifsRead();
        _notifLastCount = 0;
        _updateNotifBadge(0);
        await _loadNotifDropdown();
        if (_notifAllData.length) {
          _notifAllData.forEach((n) => n.is_read = 1);
          _renderNotifHistoryList();
        }
        showToast("All notifications marked as read", "success", "check");
      } catch (err) { handleApiError(err); }
    });

    // View All button in dropdown
    byId("notifViewAllBtn")?.addEventListener("click", () => {
      _closeNotifDropdown();
      goToPage("notifications");
    });

    // History page: search, filter, clear read, preferences
    byId("notifSearch")?.addEventListener("input", () => _renderNotifHistoryList());

    byId("notifFilterType")?.addEventListener("change", (e) => {
      _notifHistoryFilters.type = e.target.value;
      renderNotifHistory();
    });

    byId("notifFilterStatus")?.addEventListener("change", (e) => {
      _notifHistoryFilters.is_read = e.target.value;
      renderNotifHistory();
    });

    byId("notifClearReadBtn")?.addEventListener("click", async () => {
      openConfirm(
        "Clear Read Notifications",
        "This will permanently delete all notifications you have already read. Continue?",
        async () => {
          try {
            await api.deleteAllReadNotifs();
            showToast("All read notifications cleared", "success", "broom");
            await renderNotifHistory();
          } catch (err) { handleApiError(err); }
        }
      );
    });

    // Preferences modal
    byId("notifOpenPrefBtn")?.addEventListener("click", async () => {
      await _loadNotifPreferences();
      byId("notifPrefModal")?.classList.remove("hidden");
    });
    byId("closeNotifPrefModal")?.addEventListener("click", () => byId("notifPrefModal")?.classList.add("hidden"));
    byId("cancelNotifPrefModal")?.addEventListener("click", () => byId("notifPrefModal")?.classList.add("hidden"));
    byId("saveNotifPrefBtn")?.addEventListener("click", () => _saveNotifPreferences());

    byId("notifPrefModal")?.addEventListener("click", (e) => {
      if (e.target === byId("notifPrefModal")) byId("notifPrefModal").classList.add("hidden");
    });
  }

  /* ============================================================
     RESPONSIVE, IMAGE COMPRESSION & OFFLINE HANDLERS
     ============================================================ */

  // Canvas-based client-side image compression to optimize uploads for Hostinger Shared Hosting
  async function compressImageFile(file, maxWidth = 1200, maxHeight = 1200, quality = 0.8) {
    if (!file || !(file instanceof File) || !file.type.startsWith("image/")) return file;
    if (file.size < 400 * 1024) return file; // Skip small images under 400KB

    return new Promise((resolve) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = (e) => {
        img.onload = () => {
          let width = img.width;
          let height = img.height;

          if (width > maxWidth || height > maxHeight) {
            if (width / height > maxWidth / maxHeight) {
              height = Math.round((height * maxWidth) / width);
              width = maxWidth;
            } else {
              width = Math.round((width * maxHeight) / height);
              height = maxHeight;
            }
          }

          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);

          canvas.toBlob(
            (blob) => {
              if (blob) {
                const compressedFile = new File([blob], file.name.replace(/\.[^/.]+$/, "") + ".jpg", {
                  type: "image/jpeg",
                  lastModified: Date.now(),
                });
                resolve(compressedFile);
              } else {
                resolve(file);
              }
            },
            "image/jpeg",
            quality
          );
        };
        img.onerror = () => resolve(file);
        img.src = e.target.result;
      };
      reader.onerror = () => resolve(file);
      reader.readAsDataURL(file);
    });
  }

  // Render mobile touch-optimized card layout for tables (<768px)
  function renderRecordsMobileCards() {
    const mobileCardsContainer = byId("recordsMobileCards");
    if (!mobileCardsContainer) return;
    const list = filteredRecords();

    if (!list.length) {
      mobileCardsContainer.innerHTML = "";
      return;
    }

    mobileCardsContainer.innerHTML = list.map((r) => {
      const { approval, fuelBtns } = statusBadges(r);
      const isApproved = r.approvalStatus === "approved";
      const isDraft = r.isDraft;
      const statusBadge = isDraft
        ? `<span class="badge badge-draft">Draft</span>`
        : isApproved
        ? `<span class="badge badge-approved"><i class="fa-solid fa-circle-check"></i> Approved</span>`
        : `<span class="badge badge-pending"><i class="fa-solid fa-hourglass-half"></i> Pending</span>`;

      return `
        <div class="mobile-card" data-id="${r.id}">
          <div class="mobile-card-header">
            <div class="mobile-card-title">
              <strong>${r.id}</strong>
              <span style="font-size:12px;color:var(--text-muted);font-weight:normal;margin-left:6px;">${formatDateDisplay(r.date)}</span>
            </div>
            ${statusBadge}
          </div>
          <div class="mobile-card-body">
            <div class="mobile-card-row">
              <span class="mobile-card-label"><i class="fa-solid fa-user"></i> Driver</span>
              <span class="mobile-card-val">${escapeHtml(r.driver)}</span>
            </div>
            <div class="mobile-card-row">
              <span class="mobile-card-label"><i class="fa-solid fa-car"></i> Vehicle</span>
              <span class="mobile-card-val">${escapeHtml(r.vehicleNumber)}</span>
            </div>
            <div class="mobile-card-row">
              <span class="mobile-card-label"><i class="fa-solid fa-gas-pump"></i> Fuel</span>
              <span class="mobile-card-val">${escapeHtml(r.fuelType) || "-"} (${r.liters || 0} L)</span>
            </div>
            <div class="mobile-card-row">
              <span class="mobile-card-label"><i class="fa-solid fa-money-bill"></i> Total</span>
              <span class="mobile-card-val" style="color:var(--primary);font-size:15px;font-weight:800;">${formatMoney(r.totalAmount)}</span>
            </div>
          </div>
          <div class="mobile-card-footer">
            <div style="font-size:12px;">${approval}</div>
            <div class="mobile-card-actions">
              <button class="btn btn-outline btn-xs" data-act="view" data-id="${r.id}"><i class="fa-solid fa-eye"></i> View</button>
              <button class="btn btn-outline btn-xs" data-act="edit" data-id="${r.id}"><i class="fa-solid ${r.locked ? "fa-lock" : "fa-pen"}"></i> Edit</button>
              ${currentUser && currentUser.role === "admin" ? `<button class="btn btn-ghost btn-xs text-danger" data-act="delete" data-id="${r.id}"><i class="fa-solid fa-trash"></i></button>` : ""}
            </div>
          </div>
        </div>`;
    }).join("");
  }

  function initOfflineAndPerformanceHandlers() {
    // Offline / Online network detection
    const banner = byId("offlineBanner");
    function updateOnlineStatus() {
      const isOffline = !navigator.onLine;
      if (banner) banner.classList.toggle("hidden", !isOffline);
      if (isOffline) {
        showToast("Internet Connection Lost — Operating in offline view mode.", "warning", "wifi-slash");
      } else {
        showToast("Internet Connection Restored.", "success", "wifi");
      }
    }
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);

    if (!navigator.onLine && banner) banner.classList.remove("hidden");

    // Responsive resize handler to keep mobile cards / table sync
    window.addEventListener("resize", debounce(() => {
      if (currentPage === "records") {
        renderRecordsTable();
      }
    }, 200));
  }

  /* === END OF NOTIFICATIONS & RESPONSIVE MODULES === */
})();

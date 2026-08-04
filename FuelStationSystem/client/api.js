/* ============================================================
   Fuel Station Management System — API client
   Thin fetch() wrapper around the Express/MySQL backend. Kept in its
   own file so script.js's application logic doesn't get tangled up
   with HTTP plumbing.
   ============================================================ */
(function (window) {
  "use strict";

  const API_BASE = "/api/v1";
  const TOKEN_KEY = "fsms_token"; // the JWT itself — not application data,
                                  // so this is a legitimate, small use of
                                  // localStorage even though records/drivers/
                                  // settings/etc. all now live in MySQL.

  let authToken = localStorage.getItem(TOKEN_KEY) || null;

  function setAuthToken(token) {
    authToken = token;
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function getAuthToken() {
    return authToken;
  }

  // Core request helper. `body` may be a plain object (sent as JSON) or a
  // FormData instance (sent as multipart, for endpoints that accept files).
  async function request(path, { method = "GET", body, isForm = false } = {}) {
    const headers = {};
    if (authToken) headers.Authorization = "Bearer " + authToken;
    if (body && !isForm) headers["Content-Type"] = "application/json";

    const res = await fetch(API_BASE + path, {
      method,
      headers,
      body: isForm ? body : body ? JSON.stringify(body) : undefined,
    });

    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      // no JSON body (e.g. a network-level failure) — data stays null
    }

    if (!res.ok) {
      const message = (data && data.message) || `Request failed (HTTP ${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const api = {
    setAuthToken,
    getAuthToken,

    // --- Auth ---
    login: (username, password) => request("/auth/login", { method: "POST", body: { username, password } }),
    me: () => request("/auth/me"),
    logout: () => request("/auth/logout", { method: "POST" }).catch(() => {}), // best-effort

    // --- User Management (admin) + Profile (self-service) ---
    getUsers: (params) => request(`/users?${new URLSearchParams(params || {}).toString()}`),
    getUser: (id) => request(`/users/${id}`),
    createUser: (formData) => request("/users", { method: "POST", body: formData, isForm: true }),
    updateUser: (id, formData) => request(`/users/${id}`, { method: "PUT", body: formData, isForm: true }),
    resetUserPassword: (id, newPassword) => request(`/users/${id}/reset-password`, { method: "POST", body: { newPassword } }),
    activateUser: (id) => request(`/users/${id}/activate`, { method: "POST" }),
    deactivateUser: (id) => request(`/users/${id}/deactivate`, { method: "POST" }),
    deleteUser: (id) => request(`/users/${id}`, { method: "DELETE" }),
    getMyProfile: () => request("/users/me"),
    getMyAuditLogs: () => request("/users/me/audit-logs"),
    updateMyProfile: (formData) => request("/users/me", { method: "PUT", body: formData, isForm: true }),
    changeMyPassword: (currentPassword, newPassword, confirmPassword) =>
      request("/users/me/change-password", { method: "POST", body: { currentPassword, newPassword, confirmPassword } }),
    getDriverProfile: (id) => request(id ? `/users/${id}/driver-profile` : "/users/me/driver-profile"),
    updateDriverProfile: (id, formData) => request(id ? `/users/${id}/driver-profile` : "/users/me/driver-profile", { method: "PUT", body: formData, isForm: true }),
    updateDriverVerificationStatus: (id, status) => request(`/users/${id}/verification-status`, { method: "PUT", body: { status } }),

    // --- Drivers / Sirs / Fuel Types / Stations ---
    getDrivers: () => request("/drivers"),
    addDriver: (name) => request("/drivers", { method: "POST", body: { name } }),
    deleteDriver: (id) => request(`/drivers/${id}`, { method: "DELETE" }),

    getSirs: () => request("/sirs"),
    addSir: (name) => request("/sirs", { method: "POST", body: { name } }),
    deleteSir: (id) => request(`/sirs/${id}`, { method: "DELETE" }),

    getFuelTypes: () => request("/fuel-types"),
    addFuelType: (name) => request("/fuel-types", { method: "POST", body: { name } }),
    deleteFuelType: (id) => request(`/fuel-types/${id}`, { method: "DELETE" }),

    getStations: () => request("/stations"),
    addStation: (name) => request("/stations", { method: "POST", body: { name } }),
    deleteStation: (id) => request(`/stations/${id}`, { method: "DELETE" }),

    // --- Fuel Records ---
    getRecords: () => request("/records"),
    createRecord: (formData) => request("/records", { method: "POST", body: formData, isForm: true }),
    updateRecord: (code, formData) => request(`/records/${code}`, { method: "PUT", body: formData, isForm: true }),
    deleteRecord: (code) => request(`/records/${code}`, { method: "DELETE" }),
    deleteRecordPhoto: (code, photoType, reason) => request(`/records/${code}/photos/${photoType}`, { method: "DELETE", body: { reason } }),
    // image: "machine" | "money" — marks that one mandatory photo as reviewed.
    reviewRecordImage: (code, image) => request(`/records/${code}/review`, { method: "POST", body: { image } }),
    approveRecord: (code, formData) => request(`/records/${code}/approve`, { method: "POST", body: formData, isForm: true }),
    unlockRecord: (code) => request(`/records/${code}/unlock`, { method: "POST" }),
    setFuelStatus: (code, status) => request(`/records/${code}/fuel-status`, { method: "POST", body: { status } }),
    deleteUserProfilePhoto: (id, reason) => request(`/users/${id}/photo`, { method: "DELETE", body: { reason } }),

    // --- Reports (aggregated server-side, directly from MySQL) ---
    getReport: (params) => request(`/reports?${new URLSearchParams(params).toString()}`),

    // --- Settings ---
    getSettings: () => request("/settings"),
    updateSettings: (formData) => request("/settings", { method: "PUT", body: formData, isForm: true }),

    // --- Backup / Restore ---
    getBackup: () => request("/backup/export"),
    restoreBackup: (data) => request("/backup/import", { method: "POST", body: data }),
    clearAllData: () => request("/backup/clear-all", { method: "DELETE" }),

    // --- Notifications ---
    getNotifications: (params = {}) => request(`/notifications?${new URLSearchParams(params).toString()}`),
    getUnreadNotifCount: () => request("/notifications/unread-count"),
    markNotifRead: (id) => request(`/notifications/${id}/read`, { method: "PUT" }),
    markAllNotifsRead: () => request("/notifications/read-all", { method: "PUT" }),
    deleteNotif: (id) => request(`/notifications/${id}`, { method: "DELETE" }),
    deleteAllReadNotifs: () => request("/notifications/read", { method: "DELETE" }),
    // --- System & Governance APIs ---
    getHealth: () => request("/health"),
    getSystemInfo: () => request("/system/info"),
    getStorageStats: () => request("/system/storage"),
    getDeploymentHistory: () => request("/system/deployments"),
    getEnvCheck: () => request("/system/env-check"),
    getMaintenanceStatus: () => request("/system/maintenance"),
    toggleMaintenance: (enable) => request("/system/maintenance", { method: "POST", body: { enable } }),
    getReleaseNotes: () => request("/system/release-notes"),
  };

  window.api = api;
})(window);

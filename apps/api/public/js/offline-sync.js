// Kodspot Electrical — Persistent offline sync queue using IndexedDB
// Replaces the in-memory retryQueue with a durable store that survives page reloads

(function (window) {
  'use strict';

  var DB_NAME = 'kodspot-sync';
  var DB_VERSION = 1;
  var STORE_NAME = 'pending-requests';
  var db = null;

  // ─── Open / initialise the database ───
  function openDB() {
    return new Promise(function (resolve, reject) {
      if (db) return resolve(db);
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains(STORE_NAME)) {
          var store = d.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = function (e) { db = e.target.result; resolve(db); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  // ─── Queue a request for later replay ───
  // entry: { url, method, headers, body, createdAt }
  function enqueue(entry) {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        entry.createdAt = entry.createdAt || Date.now();
        // Sanitise: strip Authorization header so we re-attach a fresh token on replay
        if (entry.headers) {
          var h = {};
          Object.keys(entry.headers).forEach(function (k) {
            if (k.toLowerCase() !== 'authorization') h[k] = entry.headers[k];
          });
          entry.headers = h;
        }
        var tx = d.transaction(STORE_NAME, 'readwrite');
        var store = tx.objectStore(STORE_NAME);
        var req = store.add(entry);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ─── Get all pending entries (oldest first) ───
  function getAll() {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE_NAME, 'readonly');
        var store = tx.objectStore(STORE_NAME);
        var req = store.index('createdAt').getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ─── Remove a successfully replayed entry ───
  function remove(id) {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE_NAME, 'readwrite');
        var store = tx.objectStore(STORE_NAME);
        var req = store.delete(id);
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ─── Count pending items ───
  function count() {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE_NAME, 'readonly');
        var store = tx.objectStore(STORE_NAME);
        var req = store.count();
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ─── Clear all (admin utility) ───
  function clearAll() {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE_NAME, 'readwrite');
        var store = tx.objectStore(STORE_NAME);
        var req = store.clear();
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // Expose globally
  window.KodspotSync = {
    enqueue: enqueue,
    getAll: getAll,
    remove: remove,
    count: count,
    clearAll: clearAll
  };
})(window);

// src/api.js

// ----------- client identity (per-browser) -----------
const CID_KEY = "ra_client_id";
let CLIENT_ID = localStorage.getItem(CID_KEY);
if (!CLIENT_ID) {
  CLIENT_ID = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
  localStorage.setItem(CID_KEY, CLIENT_ID);
}
function authHeaders(extra = {}) {
  return { "x-client-id": CLIENT_ID, ...extra };
}

// ----------- base URL from Vite env -----------
const RAW_BASE = import.meta.env.VITE_API_BASE || "";
// allow users to paste full URL w/ trailing /v1 etc
const BASE = RAW_BASE.replace(/\/+$/, "");

// Build absolute URL safely
function apiUrl(path, qs = {}) {
  const p = path.startsWith("/") ? path : `/${path}`;
  const q = Object.keys(qs).length ? `?${new URLSearchParams(qs).toString()}` : "";
  return `${BASE}${p}${q}`;
}

// Shared fetch with useful error text
async function apiFetch(path, { method = "GET", headers = {}, body, qs } = {}) {
  const url = apiUrl(path, qs);
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...headers },
    body,
    mode: "cors",
    credentials: "omit",
  });

  if (!res.ok) {
    // Try to surface server text when something goes wrong
    const text = await res.text().catch(() => "");
    // If Lambda ever returns HTML (e.g., error page), make that obvious
    const hint =
      (res.headers.get("content-type") || "").includes("text/html")
        ? " (HTML response)"
        : "";
    throw new Error(`${method} ${url} failed: ${res.status}${hint} ${text.slice(0, 300)}`);
  }

  // Some endpoints might legitimately return empty body
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      return res.json();
    } catch (e) {
      const text = await res.text().catch(() => "");
      throw new Error(`Expected JSON from ${url}, got ${ct || "unknown"}: ${text.slice(0, 300)}`);
    }
  }

  // default: return raw text
  return res.text();
}

// -------------- Public API -----------------

export async function uploadResume({ userId, file }) {
  const contentBase64 = await fileToBase64(file);
  return apiFetch("/upload/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, filename: file.name, contentBase64 }),
  });
}

export async function listDocuments(userId) {
  return apiFetch("/documents", { qs: { userId }, headers: authHeaders() });
}

export async function deleteDocument({ userId, documentId }) {
  return apiFetch("/documents/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ userId, documentId }),
  });
}

export async function tailorResume({ userId, documentId, jobUrl, interests }) {
  return apiFetch("/tailor", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ userId, documentId, jobUrl, interests }),
  });
}

// Fetch the original HTML from S3 via the API (avoids CORS on S3)
export async function getHtml({ documentId, s3Key, userId }) {
  const qs = { userId };
  if (documentId) qs.documentId = documentId;
  if (s3Key) qs.s3Key = s3Key;
  return apiFetch("/documents/html", { qs, headers: authHeaders() });
}

// -------------- Utils -----------------
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("File read error"));
    reader.onload = () => {
      const s = String(reader.result || "");
      resolve(s.includes(",") ? s.split(",").pop() : s);
    };
    reader.readAsDataURL(file);
  });
}

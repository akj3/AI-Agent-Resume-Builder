// src/api.js

const RAW_BASE = import.meta.env.VITE_API_BASE || "";

const API_BASE = RAW_BASE.replace(/\/+$/, "");

// Small helper to build URLs safely
const apiUrl = (path, qs) =>
  API_BASE + path + (qs ? `?${new URLSearchParams(qs).toString()}` : "");

// Shared fetch wrapper (optional but handy)
async function apiFetch(path, { method = "GET", headers = {}, body, qs } = {}) {
  const res = await fetch(apiUrl(path, qs), {
    method,
    headers,
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} failed: ${res.status} ${text || ""}`.trim());
  }
  return res.json();
}

// ---------- Public API ----------

export async function uploadResume({ userId, file }) {
  const contentBase64 = await fileToBase64(file);
  return apiFetch("/upload/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, filename: file.name, contentBase64 }),
  });
}

export async function listDocuments(userId) {
  return apiFetch("/documents", { qs: { userId } });
}

export async function deleteDocument({ userId, documentId }) {
  return apiFetch("/documents/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, documentId }),
  });
}

export async function tailorResume({ userId, documentId, jobUrl, interests }) {
  return apiFetch("/tailor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, documentId, jobUrl, interests }),
  });
}

// ---------- Utils ----------
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

const BASE = "https://kuwewg6au3kjt6wia54cincyra0baepn.lambda-url.us-east-2.on.aws";


async function uploadResume({ userId, file }) {
  const contentBase64 = await fileToBase64(file);
  const res = await fetch(`${BASE}/upload/resume`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ userId, filename: file.name, contentBase64 })
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

async function listDocuments(userId) {
  const res = await fetch(`${BASE}/documents?userId=${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error(`List failed: ${res.status}`);
  return res.json();
}

async function deleteDocument({ userId, documentId }) {
  const res = await fetch(`${BASE}/documents/delete`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ userId, documentId })
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
  return res.json();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("File read error"));
    reader.onload = () => resolve(String(reader.result).split(",").pop());
    reader.readAsDataURL(file);
  });
}

export async function tailorResume({ userId, documentId, jobUrl, interests }) {
  const r = await fetch(`${BASE}/tailor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, documentId, jobUrl, interests }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Tailor failed (${r.status}): ${txt}`);
  }
  return r.json();
}

export { uploadResume, listDocuments, deleteDocument };


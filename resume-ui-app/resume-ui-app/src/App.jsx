import { useEffect, useMemo, useState } from "react";
import {
  uploadResume,
  listDocuments,
  deleteDocument,
  tailorResume,
} from "./api";
import "./index.css";
import { Link } from "react-router-dom";

const MAX_DOCS = 10;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_EXTS = [".pdf", ".doc", ".docx", ".txt"];

export default function App() {
  const [userId, setUserId] = useState("u1");

  // documents
  const [docs, setDocs] = useState([]);
  const [filterText, setFilterText] = useState("");

  // upload
  const [file, setFile] = useState(null);
  const [uploadError, setUploadError] = useState("");

  // AI / tailoring
  const [interests, setInterests] = useState("");
  const [jobUrl, setJobUrl] = useState("");
  const [selectedDocId, setSelectedDocId] = useState("");

  // ui state
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  const canTailor = Boolean(selectedDocId && jobUrl && !loading);

  // ---------- persistence (per userId) ----------
  const STORAGE_KEY = (uid) => `prefs:${uid}`;
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY(userId));
      if (raw) {
        const { interests: i, jobUrl: j, selectedDocId: s } = JSON.parse(raw);
        if (typeof i === "string") setInterests(i);
        if (typeof j === "string") setJobUrl(j);
        if (typeof s === "string") setSelectedDocId(s);
      }
    } catch {}
  }, [userId]);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY(userId),
        JSON.stringify({ interests, jobUrl, selectedDocId })
      );
    } catch {}
  }, [userId, interests, jobUrl, selectedDocId]);

  // ---------- derived ----------
  const totalSize = useMemo(
    () => docs.reduce((sum, d) => sum + Number(d.size || 0), 0),
    [docs]
  );

  // Only render up to MAX_DOCS in the right column to avoid very tall pages.
  const visibleDocs = useMemo(() => docs.slice(0, MAX_DOCS), [docs]);

  const filteredDocs = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    const pool = visibleDocs;
    if (!q) return pool;
    return pool.filter((d) =>
      [d.s3Key, d.documentId, d.contentType, d.type].join(" ").toLowerCase().includes(q)
    );
  }, [visibleDocs, filterText]);

  // ---------- data ----------
  async function refresh() {
    setLoading(true);
    setMsg("");
    try {
      const data = await listDocuments(userId);
      const items = data.items || [];
      setDocs(items);

      // choose selected doc (prefer stored; else most recent)
      if (!items.find((d) => d.documentId === selectedDocId)) {
        setSelectedDocId(items[0]?.documentId || "");
      }
    } catch (e) {
      setMsg(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- upload validation ----------
  function validateFile(f) {
    if (!f) return "Pick a file first.";
    const name = (f.name || "").toLowerCase();
    const okExt = ALLOWED_EXTS.some((ext) => name.endsWith(ext));
    if (!okExt) return `Unsupported type. Allowed: ${ALLOWED_EXTS.join(", ")}`;
    if (f.size > MAX_UPLOAD_BYTES) {
      return `File is too large. Max is 10 MB, got ${(f.size / 1024 / 1024).toFixed(2)} MB.`;
    }
    return "";
  }

  // ---------- actions ----------
  async function onUpload(e) {
    e.preventDefault();
    if (docs.length >= MAX_DOCS) {
      setMsg(`Upload limit reached (${MAX_DOCS}). Delete a document to add more.`);
      return;
    }
    if (!file) return setMsg("Pick a file first.");
    const err = validateFile(file);
    if (err) {
      setUploadError(err);
      setMsg(`Upload error: ${err}`);
      return;
    }

    setLoading(true);
    setMsg("");
    try {
      const res = await uploadResume({ userId, file });
      setMsg(`Uploaded: ${res.s3Key}`);
      await refresh();
      setFile(null);
      setUploadError("");
      e.target.reset?.();
    } catch (e) {
      setMsg("Upload error: " + (e.message || e));
    } finally {
      setLoading(false);
    }
  }

  async function onDelete(doc) {
    if (!confirm(`Delete ${doc.s3Key}?`)) return;
    setLoading(true);
    setMsg("");
    try {
      await deleteDocument({ userId, documentId: doc.documentId });
      await refresh();
      setMsg("Deleted.");
    } catch (e) {
      setMsg("Delete error: " + (e.message || e));
    } finally {
      setLoading(false);
    }
  }

  async function onTailor() {
    if (!selectedDocId) return setMsg("Select a resume to tailor.");
    if (!jobUrl) return setMsg("Paste a job description URL.");
    setLoading(true);
    setMsg("Tailoring resume with AI…");
    try {
      const res = await tailorResume({
        userId,
        documentId: selectedDocId,
        jobUrl,
        interests,
      });
      if (res?.ok) {
        setMsg(`Tailored resume created: ${res.s3Key}`);
        await refresh();
      } else {
        setMsg("Tailor request submitted. Check documents in a moment.");
      }
    } catch (e) {
      setMsg("AI tailoring error: " + (e.message || e));
    } finally {
      setLoading(false);
    }
  }

  // ---------- helpers ----------
  function addChip(text) {
    const existing = new Set(
      interests
        .split(/[, ]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.toLowerCase())
    );
    if (!existing.has(text.toLowerCase())) {
      const sep = interests.trim().length ? ", " : "";
      setInterests((prev) => prev + sep + text);
    }
  }

  return (
    <div style={styles.shell}>
      {/* 2 columns: left stack (upload + AI) and right (documents) */}
      <div className="page-grid" style={styles.page}>
        {/* LEFT COLUMN (stacked cards) */}
        <div style={styles.leftCol}>
          {/* Upload card */}
          <section style={styles.card}>
            <h1 style={styles.h1}>Resume Assistant (Local Dev)</h1>
            <p style={styles.subtle}>
              Backend via local signing proxy (http://localhost:5174)
            </p>

            <form onSubmit={onUpload} style={styles.form}>
              <label style={styles.row}>
                <span>User ID</span>
                <input
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  style={styles.input}
                  placeholder="u1"
                />
              </label>

              <label style={styles.row}>
                <span>File</span>
                <input
                  type="file"
                  accept="application/pdf,.pdf,application/msword,.doc,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,text/plain,.txt"
                  onChange={(e) => {
                    const f = e.target.files?.[0] || null;
                    setFile(f);
                    setUploadError(validateFile(f));
                  }}
                  style={styles.input}
                />
              </label>
              {uploadError && (
                <div style={{ color: "#ff8585", fontSize: 12, marginTop: 6 }}>
                  {uploadError}
                </div>
              )}

              <button
                disabled={loading || !file || !!uploadError || docs.length >= MAX_DOCS}
                title={
                  docs.length >= MAX_DOCS
                    ? `Upload limit reached (${MAX_DOCS}).`
                    : uploadError || ""
                }
                style={styles.button}
              >
                {loading ? "Working..." : "Upload"}
              </button>
            </form>

            {msg && <div style={styles.note}>{msg}</div>}
          </section>

          {/* Career & AI card (directly beneath Upload) */}
          <section style={styles.card}>
            <h3 style={styles.h3}>Career & AI</h3>

            <label style={styles.row}>
              <span>Career interests / keywords</span>
              <input
                value={interests}
                onChange={(e) => setInterests(e.target.value)}
                style={styles.input}
                placeholder="ex: data science, ML, product analytics"
              />
              <div style={styles.helper}>Tip: comma or space-separated.</div>
            </label>

            <label style={{ ...styles.row, marginTop: 14 }}>
              <span>Job description URL</span>
              <input
                value={jobUrl}
                onChange={(e) => setJobUrl(e.target.value)}
                style={styles.input}
                placeholder="Paste a role link (e.g., Lever/Greenhouse/company careers)"
              />
            </label>

            <label style={styles.row}>
              <span>Select resume to tailor</span>
              <select
                value={selectedDocId}
                onChange={(e) => setSelectedDocId(e.target.value)}
                style={{ ...styles.input, height: 40 }}
              >
                <option value="">— choose from your uploads —</option>
                {docs.map((d) => (
                  <option key={d.documentId} value={d.documentId}>
                    {d.s3Key}
                  </option>
                ))}
              </select>
            </label>

            <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
              <button
                type="button"
                onClick={onTailor}
                disabled={!canTailor}
                style={{
                  ...styles.buttonPrimary,
                  ...(canTailor ? {} : styles.buttonPrimaryDisabled),
                }}
              >
                {loading ? "Tailoring…" : "Tailor with AI"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setInterests("");
                  setJobUrl("");
                  setMsg("");
                }}
                style={styles.ghostBtn}
              >
                Clear
              </button>
            </div>
          </section>
        </div>

        {/* RIGHT COLUMN (documents) */}
        <section style={{ ...styles.card, minHeight: 240, marginLeft: 50 }}>
          <div style={styles.headerRow}>
            <p style={{ marginTop: 6, color: "#8692ab", fontSize: 13 }}>
              <Link to="/" style={{ color: "#98b7ff", textDecoration: "none" }}>
                ← Home
              </Link>
            </p>
            <div>
              <h2 style={styles.h2}>Your Documents</h2>
              <div style={styles.meta}>
                Count: {docs.length} • Total size: {totalSize} bytes{" "}
                {docs.length > MAX_DOCS && (
                  <span style={{ marginLeft: 8, opacity: 0.8 }}>
                    (showing first {MAX_DOCS})
                  </span>
                )}
              </div>
            </div>

            <button onClick={refresh} disabled={loading} style={styles.ghostBtn}>
              Refresh
            </button>
          </div>

          <div style={{ ...styles.row, marginBottom: 10 }}>
            <input
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              style={styles.input}
              placeholder="Filter by filename, id, type…"
            />
          </div>

          {!filteredDocs.length && (
            <div style={styles.empty}>No documents match your filter.</div>
          )}

          <ul style={styles.list}>
            {filteredDocs.map((doc) => (
              <li key={doc.documentId} style={styles.listItem}>
                <div style={{ flex: "1 1 auto" }}>
                  <div className="break-anywhere" style={styles.fileName}>
                    {doc.s3Key}{" "}
                    {doc.type && (
                      <span
                        style={{
                          ...styles.badge,
                          background:
                            doc.type === "resume_tailored" ? "#2fe6a71a" : "#4a8cff1a",
                          border:
                            doc.type === "resume_tailored"
                              ? "1px solid #2fe6a7"
                              : "1px solid #4a8cff",
                          color:
                            doc.type === "resume_tailored" ? "#2fe6a7" : "#98b7ff",
                        }}
                        title={doc.type}
                      >
                        {doc.type === "resume_tailored" ? "Tailored" : "Original"}
                      </span>
                    )}
                  </div>
                  <div style={styles.fileMeta}>
                    {doc.contentType} • {doc.size ?? "?"} bytes • {doc.documentId}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 12,
                      color: "#a9b4d0",
                    }}
                  >
                    <input
                      type="radio"
                      name="tailor-doc"
                      checked={selectedDocId === doc.documentId}
                      onChange={() => setSelectedDocId(doc.documentId)}
                    />
                    Use for AI
                  </label>

                  {(() => {
                    const isHtml = (doc.contentType || "").startsWith("text/html");
                    // Route tailored HTML docs to the in-app viewer
                    if (isHtml || doc.type === "resume_tailored") {
                      return (
                        <Link
                          to={`/viewer/${doc.documentId}?userId=${encodeURIComponent(userId)}`}
                          style={styles.linkBtn}
                        >
                          Open
                        </Link>
                      );
                    }
                    // Otherwise use the presigned S3 URL
                    if (doc.url) {
                      return (
                        <a
                          href={doc.url}
                          target="_blank"
                          rel="noreferrer"
                          style={styles.linkBtn}
                        >
                          Open
                        </a>
                      );
                    }
                    return null;
                  })()}

                  <button onClick={() => onDelete(doc)} style={styles.dangerBtn}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

const styles = {
  shell: { background: "#0b1220", minHeight: "100vh", width: "100vw" },
  page: {
    boxSizing: "border-box",
    padding: "28px 24px",
    maxWidth: "min(1600px, 96vw)",
    margin: "0 auto",
    alignItems: "start",
    gap: 28,
  },
  leftCol: {
    display: "grid",
    gap: 16,
    marginLeft: -90,
  },

  card: {
    width: "100%",
    background: "rgba(18,26,43,0.92)",
    border: "1px solid #1f2a44",
    borderRadius: 16,
    padding: 20,
    boxShadow: "0 12px 32px rgba(0,0,0,.28)",
    backdropFilter: "saturate(110%) blur(2px)",
  },

  h1: { margin: 0, fontSize: 44, lineHeight: 1.05, letterSpacing: 0.2 },
  h2: { margin: 0, fontSize: 22 },
  h3: { margin: 0, fontSize: 18 },
  subtle: { marginTop: 6, color: "#8692ab", fontSize: 13 },

  form: { display: "grid", gap: 12, marginTop: 16 },
  row: { display: "grid", gap: 6, fontSize: 14 },

  input: {
    background: "#0f1626",
    border: "1px solid #233056",
    color: "#e6eaf2",
    padding: "10px 12px",
    borderRadius: 10,
    outline: "none",
  },

  button: {
    background: "#4a8cff",
    border: "1px solid #4a8cff",
    color: "#061126",
    fontWeight: 700,
    padding: "12px 14px",
    borderRadius: 12,
    cursor: "pointer",
  },

  buttonPrimary: {
    background: "#2fe6a7",
    border: "1px solid #2fe6a7",
    color: "#06291f",
    fontWeight: 700,
    padding: "12px 14px",
    borderRadius: 12,
    cursor: "pointer",
    transition: "transform .12s ease, box-shadow .12s ease",
  },
  buttonPrimaryDisabled: {
    background: "#1e2639",
    border: "1px solid #2b3a64",
    color: "#6b768f",
    cursor: "not-allowed",
    boxShadow: "none",
    transform: "none",
  },
  ghostBtn: {
    background: "transparent",
    border: "1px solid #2b3a64",
    color: "#a9b4d0",
    padding: "8px 12px",
    borderRadius: 10,
    cursor: "pointer",
  },
  dangerBtn: {
    background: "#ff6b6b",
    border: "1px solid #ff6b6b",
    color: "#160a0a",
    padding: "8px 12px",
    borderRadius: 10,
    cursor: "pointer",
  },
  linkBtn: {
    textDecoration: "none",
    background: "#2fe6a7",
    border: "1px solid #2fe6a7",
    color: "#071512",
    padding: "8px 12px",
    borderRadius: 10,
  },

  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  meta: { fontSize: 12, color: "#8692ab", marginTop: 4 },

  list: { listStyle: "none", padding: 0, margin: 0 },
  listItem: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 14px",
    border: "1px solid #1f2a44",
    borderRadius: 12,
    marginBottom: 10,
    transition: "background .15s ease, border-color .15s ease",
  },
  fileName: { fontWeight: 600, fontSize: 15, marginBottom: 2 },
  fileMeta: { fontSize: 12, color: "#8692ab" },

  badge: {
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 999,
    marginLeft: 8,
  },

  helper: { color: "#8692ab", fontSize: 12 },

  note: { marginTop: 12, color: "#9fe6b8" },
  empty: { color: "#99a", padding: "6px 2px" },
};

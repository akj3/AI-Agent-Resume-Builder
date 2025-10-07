// src/Viewer.jsx
import { useEffect, useMemo, useState } from "react";
import { useParams, Link, useSearchParams, useNavigate } from "react-router-dom";
import { listDocuments } from "./api";

// ---------- small helpers ----------
const MONTH_MAP = {
  january: "Jan.", february: "Feb.", march: "Mar.", april: "Apr.", may: "May", june: "Jun.",
  july: "Jul.", august: "Aug.", september: "Sep.", sept: "Sep.", october: "Oct.",
  november: "Nov.", december: "Dec."
};
const RX = {
  email: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  phone: /(?:\+?\d{1,3}[\s\-\.])?(?:\(?\d{3}\)?[\s\-\.])?\d{3}[\s\-\.]\d{4}/,
  url: /(https?:\/\/[^\s)]+|www\.[^\s)]+)/ig,
  linkedin: /https?:\/\/(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%/]+/i,
  github: /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9\-_.]+/i,
  // date pieces like "May 2024 – Jul. 2024", "Sep. 2021 — May 2022", "2020–Present"
  daterange: /([A-Za-z]{3,9}\.?|\b\d{4}\b)\s*(\d{4})??\s*[–—-]\s*(Present|[A-Za-z]{3,9}\.?|\b\d{4}\b)(\s*\d{4})?/,
  // headings we care about
  heading: /^(education|experience|work experience|projects?|technical skills|skills)\b/i
};

// latex-escape a string
function lx(s = "") {
  return String(s)
    .replaceAll(/\\/g, "\\textbackslash{}")
    .replaceAll(/([{}_#$%&~^])/g, "\\$1")
    .replaceAll(/<|>/g, (m) => (m === "<" ? "\\textless{}" : "\\textgreater{}"))
    .replaceAll(/\|/g, "\\textbar{}")
    .replaceAll(/\u00A0/g, " ");
}
function normMonthWord(w) {
  if (!w) return "";
  const k = w.toLowerCase().replace(/\./g, "");
  return MONTH_MAP[k] || w;
}
function normDateRange(raw = "") {
  let s = raw.replace(/[–—-]+/g, " – ").replace(/\s+/g, " ").trim();
  s = s.replace(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?/gi,
    (m) => normMonthWord(m)
  );
  s = s.replace(/\.\./g, ".").replace(/- -/g, "–");
  s = s.replace(/\s-\s/g, " – ");
  return s;
}

// extract plain text from HTML snippet
function textOf(node) {
  return node ? (node.textContent || "").replace(/\s+/g, " ").trim() : "";
}
function cleanLines(txt) {
  return txt
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// choose best name guess from an <h1>, big first words, or the first line
function guessName(doc) {
  const h1 = doc.querySelector("h1, h2");
  const fromH = h1 ? textOf(h1) : "";
  if (fromH && fromH.split(" ").length <= 6) return fromH;
  const first = textOf(doc.body).split(/\n/)[0] || "";
  return first.split("|")[0].trim();
}

function pickLinks(allText) {
  const email = (allText.match(RX.email) || [])[0] || "";
  const phone = (allText.match(RX.phone) || [])[0] || "";
  const li = (allText.match(RX.linkedin) || [])[0] || "";
  const gh = (allText.match(RX.github) || [])[0] || "";
  // any other link (limit 2)
  const rest = (allText.match(RX.url) || []).filter(
    (u) => u !== li && u !== gh
  ).slice(0, 2);
  return { email, phone, linkedin: li, github: gh, other: rest };
}

// remove http(s):// without using a literal // (avoids template parsing issues)
const stripProto = (u) => (u ? u.replace(new RegExp('^https?:\\/\\/', 'i'), '') : '');

// crude but robust “sectionizer”: walk DOM top-down and cut where a heading matches
function chunkSections(doc) {
  const out = [];
  let cur = { name: "intro", blocks: [] };
  const walker = doc.body.querySelectorAll("*");
  for (const el of walker) {
    const tag = (el.tagName || "").toLowerCase();
    if (["script", "style", "noscript"].includes(tag)) continue;
    const t = textOf(el);
    if (!t) continue;
    if (tag.match(/^h[1-4]$/) || RX.heading.test(t)) {
      if (cur.blocks.length) out.push(cur);
      cur = { name: t.toLowerCase(), blocks: [] };
      continue;
    }
    cur.blocks.push(t);
  }
  if (cur.blocks.length) out.push(cur);

  // normalize names
  out.forEach((s) => {
    if (/education/i.test(s.name)) s.name = "Education";
    else if (/experience|work experience/i.test(s.name)) s.name = "Experience";
    else if (/project/i.test(s.name)) s.name = "Projects";
    else if (/skill/i.test(s.name)) s.name = "Technical Skills";
    else s.name = s.name[0].toUpperCase() + s.name.slice(1);
  });
  return out;
}

// EDUCATION parsing
function parseEducation(lines) {
  const rows = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const joined = buf.join(" ");
    let school = "", loc = "", degree = "", dates = "";
    const dateHit = joined.match(/(Jan\.|Feb\.|Mar\.|Apr\.|May|Jun\.|Jul\.|Aug\.|Sep\.|Oct\.|Nov\.|Dec\.)\s+\d{4}\s+[–-]\s+(?:Present|\w+\.\s+\d{4}|\d{4})/);
    if (dateHit) {
      dates = normDateRange(dateHit[0]);
    } else {
      const yearSpan = joined.match(/\b\d{4}\s+[–-]\s+(?:Present|\d{4})\b/);
      if (yearSpan) dates = normDateRange(yearSpan[0]);
    }
    const m = joined.match(/^(.+?)\s[–-]\s(.+?),\s*([A-Z]{2})/); // University — City, ST
    if (m) {
      school = m[1];
      loc = `${m[2]}, ${m[3]}`;
    } else {
      const m2 = joined.match(/^(.+?(?:University|College|Institute|School).+?)(?:\s+|,)\s+([A-Z][a-zA-Z]+,\s*[A-Z]{2})/);
      if (m2) {
        school = m2[1];
        loc = m2[2];
      } else {
        school = joined.replace(/[,|].*$/, "");
      }
    }
    const degHit = joined.match(/\b(Bachelor|Master|B\.Sc\.|M\.Sc\.|BS|BA|MS|Ph\.?D\.?).+?(Science|Arts|Engineering|Computer|CS|Information|Business|[A-Z][a-z]+)(?:,|\s|$).*/i);
    degree = degHit ? degHit[0] : joined;
    rows.push({ school, loc, degree, dates });
    buf = [];
  };

  for (const l of lines) {
    if (/^\s*(University|College|Institute|School)/i.test(l)) {
      flush();
      buf.push(l);
    } else {
      if (!buf.length) buf.push(l);
      else buf.push(l);
    }
  }
  flush();
  return rows.map((r) => ({
    school: r.school?.trim() || "",
    loc: r.loc?.trim() || "",
    degree: r.degree?.trim() || "",
    dates: r.dates ? normDateRange(r.dates) : ""
  })).filter((r) => r.school);
}

// EXPERIENCE parsing
function parseExperience(lines) {
  const jobs = [];
  let i = 0;
  while (i < lines.length) {
    let company = "", dates = "", role = "", loc = "";
    const window = lines.slice(i, i + 3).join("  ");
    const dr = window.match(/\b(Jan\.|Feb\.|Mar\.|Apr\.|May|Jun\.|Jul\.|Aug\.|Sep\.|Oct\.|Nov\.|\d{4})[^\n]{0,20}[–-][^\n]{0,20}(Present|\d{4}|Jan\.|Feb\.|Mar\.|Apr\.|May|Jun\.|Jul\.|Aug\.|Sep\.|Oct\.|Nov\.)/);
    if (dr) dates = normDateRange(dr[0]);

    company = (lines[i] || "").replace(/[•\-–].*$/, "").trim();
    const next = lines[i + 1] || "";
    if (/intern|engineer|developer|manager|lead|scientist/i.test(next)) {
      role = next.replace(/[•\-–].*$/, "").trim();
      const locHit = role.match(/[,–-]\s*([A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)*,\s*[A-Z]{2})$/);
      if (locHit) {
        loc = locHit[1]; role = role.replace(/[,–-]\s*[A-Z].+$/, "").trim();
      }
      i += 2;
    } else {
      const rr = company.split(/[–—-]/);
      if (rr.length > 1) { company = rr[0].trim(); role = rr[1].trim(); }
      i += 1;
    }

    const bullets = [];
    while (i < lines.length) {
      const l = lines[i];
      if (/^(Education|Experience|Projects?|Technical Skills|Skills)\b/i.test(l)) break;
      if (/^[•\-–]\s|^\u2022/.test(l) || l.length < 160) {
        const parts = l.split(/•/).map((x) => x.trim()).filter(Boolean);
        parts.forEach((p) => bullets.push(p));
        i += 1;
      } else break;
    }

    company = company.replace(/\s{2,}/g, " ");
    role = role.replace(/\s{2,}/g, " ");
    if (company) jobs.push({ company, dates, role, loc, bullets });
  }
  return jobs;
}

// PROJECTS parsing
function parseProjects(lines) {
  const projects = [];
  let i = 0;
  while (i < lines.length) {
    let title = "", dates = "", stack = "";
    const head = lines[i] || "";
    if (!head) { i++; continue; }
    const d = head.match(/\b(Jan\.|Feb\.|Mar\.|Apr\.|May|Jun\.|Jul\.|Aug\.|Sep\.|Oct\.|Nov\.|\d{4}).{0,20}[–-].{0,20}(Present|\d{4})\b/);
    if (d) {
      dates = normDateRange(d[0]);
      title = head.replace(d[0], "").replace(/[–—-]\s*$/, "").trim();
    } else {
      title = head.trim();
    }
    const st = title.match(/\|\s*([^|]+)$/);
    if (st) { stack = st[1].trim(); title = title.replace(/\|[^|]+$/, "").trim(); }

    const bullets = [];
    i++;
    while (i < lines.length && bullets.length < 8) {
      const l = lines[i];
      if (!l) { i++; continue; }
      if (/^(Education|Experience|Projects?|Technical Skills|Skills)\b/i.test(l)) break;
      if (l.length > 250 && !/•|-/.test(l)) break;
      const parts = l.split(/•/).map((x) => x.trim()).filter(Boolean);
      if (parts.length) parts.forEach((p) => bullets.push(p));
      else bullets.push(l);
      i++;
      if (lines[i] && lines[i].length < 64) break;
    }

    if (title) projects.push({ title, stack, dates, bullets });
  }
  return projects;
}

// SKILLS parsing
function parseSkills(lines) {
  const txt = lines.join(" ");
  const cats = {};
  const pairs = txt.split(/\s{2,}|\s*\|\s*/);
  pairs.forEach((p) => {
    const m = p.match(/\b([A-Z][A-Za-z ]{2,20})\s*:\s*(.+)$/);
    if (m) {
      const k = m[1].trim();
      const v = m[2].replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ").trim();
      cats[k] = v;
    }
  });
  if (Object.keys(cats).length) return cats;

  const fallback = {
    Languages: [],
    "Web & Services": [],
    "Developer Tools": [],
    Libraries: []
  };
  const items = txt.split(/[,•]\s*/).map((x) => x.trim()).filter(Boolean);
  items.forEach((w) => {
    if (/^(java|python|c(\+\+)?|swift|typescript|javascript|sql|r|go|rust|kotlin|scala)$/i.test(w)) fallback.Languages.push(w);
    else if (/^(react|node\.?js|flask|fastapi|django|spring|express|next\.?js)$/i.test(w)) fallback["Web & Services"].push(w);
    else if (/^(git|docker|kubernetes|vscode|postman|jira|notion|pytest)$/i.test(w)) fallback["Developer Tools"].push(w);
    else fallback.Libraries.push(w);
  });
  Object.keys(fallback).forEach((k) => (fallback[k] = Array.from(new Set(fallback[k])).join(", ")));
  return fallback;
}

// ========================== React Component ==========================
export default function Viewer() {
  const { documentId } = useParams();
  const [search] = useSearchParams();
  const userId = search.get("userId") || "u1";
  const nav = useNavigate();

  const [doc, setDoc] = useState(null);
  const [html, setHtml] = useState("");           // filled only when user clicks Get LaTeX
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const [showLatex, setShowLatex] = useState(false);
  const [copied, setCopied] = useState(false);

  // Load document metadata (but do NOT fetch the presigned URL here)
  useEffect(() => {
    (async () => {
      try {
        const data = await listDocuments(userId);
        const found = (data.items || []).find((d) => d.documentId === documentId);
        if (!found) {
          setErr("Document not found.");
          setLoading(false);
          return;
        }
        setDoc(found);
      } catch (e) {
        setErr(String(e.message || e));
      } finally {
        setLoading(false);
      }
    })();
  }, [documentId, userId]);

  // On-demand fetch for LaTeX generation (only for HTML docs)
  async function loadHtmlForLatex() {
  if (!doc?.documentId) {
    setErr("No document selected");
    setShowLatex(true);
    return;
  }
  try {
    setErr("");
    const url = `${import.meta.env.VITE_API_BASE}/documents/html?` +
                new URLSearchParams({ userId, documentId }).toString();
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const json = await res.json();
    if (!json.html) throw new Error("No HTML returned");
    setHtml(json.html);
  } catch (e) {
    console.warn(e);
    setHtml("");
    setErr("Couldn’t read HTML for LaTeX (API).");
  } finally {
    setShowLatex(true);
  }
}


  // -------- LaTeX generator (strict) --------
  const latex = useMemo(() => {
    if (!html) return "";

    // Build DOM safely
    const doc = new DOMParser().parseFromString(html, "text/html");

    // CONTACTS
    const allText = textOf(doc.body);
    const name = guessName(doc);
    const links = pickLinks(allText);

    // SECTIONS
    const sections = chunkSections(doc);
    const edSec = sections.find((s) => s.name === "Education");
    const exSec = sections.find((s) => s.name === "Experience");
    const prSec = sections.find((s) => s.name === "Projects");
    const skSec = sections.find((s) => /skill/i.test(s.name));

    const edu = edSec ? parseEducation(edSec.blocks) : [];
    const jobs = exSec ? parseExperience(exSec.blocks) : [];
    const projs = prSec ? parseProjects(prSec.blocks) : [];
    const skills = skSec ? parseSkills(skSec.blocks) : {};

    // Jake template (full preamble + macros)
    const preamble = String.raw`
%-------------------------
% Resume in Latex
% Author : Jake Gutierrez  (structure)
% This file is generated from your tailored HTML with strict parsing.
%------------------------

\documentclass[letterpaper,11pt]{article}

\usepackage{latexsym}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage{marvosym}
\usepackage[usenames,dvipsnames]{color}
\usepackage{verbatim}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\usepackage{fancyhdr}
\usepackage[english]{babel}
\usepackage{tabularx}
\input{glyphtounicode}

\pagestyle{fancy}
\fancyhf{} 
\fancyfoot{}
\renewcommand{\headrulewidth}{0pt}
\renewcommand{\footrulewidth}{0pt}

% Margins
\addtolength{\oddsidemargin}{-0.5in}
\addtolength{\evensidemargin}{-0.5in}
\addtolength{\textwidth}{1in}
\addtolength{\topmargin}{-.5in}
\addtolength{\textheight}{1.0in}

\urlstyle{same}
\raggedbottom
\raggedright
\setlength{\tabcolsep}{0in}

\titleformat{\section}{\vspace{-4pt}\scshape\raggedright\large}{}{0em}{}[\color{black}\titlerule \vspace{-5pt}]
\pdfgentounicode=1

% ------------- Custom macros (Jake) -------------
\newcommand{\resumeItem}[1]{\item\small{#1 \vspace{-2pt}}}
\newcommand{\resumeSubheading}[4]{
  \vspace{-2pt}\item
  \begin{tabular*}{0.97\textwidth}[t]{l@{\extracolsep{\fill}}r}
    \textbf{#1} & #2 \\
    \textit{\small #3} & \textit{\small #4} \\
  \end{tabular*}\vspace{-7pt}
}
\newcommand{\resumeProjectHeading}[2]{
  \item
  \begin{tabular*}{0.97\textwidth}{l@{\extracolsep{\fill}}r}
    \small #1 & #2 \\
  \end{tabular*}\vspace{-7pt}
}
\newcommand{\resumeSubHeadingListStart}{\begin{itemize}[leftmargin=0.15in, label={}]} 
\newcommand{\resumeSubHeadingListEnd}{\end{itemize}}
\newcommand{\resumeItemListStart}{\begin{itemize}}
\newcommand{\resumeItemListEnd}{\end{itemize}\vspace{-5pt}}
`;

    const contacts = [
      links.phone && lx(links.phone),
      links.email && `\\href{mailto:${lx(links.email)}}{\\underline{${lx(links.email)}}}`,
      links.linkedin && `\\href{${lx(links.linkedin)}}{\\underline{${lx(stripProto(links.linkedin))}}}`,
      links.github && `\\href{${lx(links.github)}}{\\underline{${lx(stripProto(links.github))}}}`
    ].filter(Boolean).join(" $|$ ");

    const heading = String.raw`
\begin{document}
\begin{center}
  \textbf{\Huge \scshape ${lx(name)}} \\ \vspace{1pt}
  \small ${contacts}
\end{center}
`;

    // education
    const edBlock = edu.length ? String.raw`
\section{Education}
\resumeSubHeadingListStart
${edu.map(e =>
  String.raw`\resumeSubheading{${lx(e.school)}}{${lx(e.loc)}}
{${lx(e.degree)}}{${lx(e.dates)}}`
).join("\n")}
\resumeSubHeadingListEnd
` : "";

    // experience
    const exBlock = jobs.length ? String.raw`
\section{Experience}
\resumeSubHeadingListStart
${jobs.map(j => {
  const bullets = (j.bullets || []).slice(0, 6)
    .map(b => `\\resumeItem{${lx(b)}}`).join("\n");
  return String.raw`\resumeSubheading{${lx(j.company)}}{${lx(normDateRange(j.dates || ""))}}
{${lx(j.role || "")}}{${lx(j.loc || "")}}
\resumeItemListStart
${bullets}
\resumeItemListEnd`;
}).join("\n\n")}
\resumeSubHeadingListEnd
` : "";

    // projects
    const prBlock = projs.length ? String.raw`
\section{Projects}
\resumeSubHeadingListStart
${projs.map(p => {
  const right = lx(normDateRange(p.dates || ""));
  const left = `\\textbf{${lx(p.title)}}${p.stack ? ` \\emph{${lx(p.stack)}}` : ""}`;
  const items = (p.bullets || []).slice(0, 5).map(b => `\\resumeItem{${lx(b)}}`).join("\n");
  return String.raw`\resumeProjectHeading{${left}}{${right}}
\resumeItemListStart
${items}
\resumeItemListEnd`;
}).join("\n\n")}
\resumeSubHeadingListEnd
` : "";

    // skills
    const skBlock = Object.keys(skills).length ? String.raw`
\section{Technical Skills}
\begin{itemize}[leftmargin=0.15in, label={}]
  \small{\item{
${Object.entries(skills).map(([k, v]) =>
  `    \\textbf{${lx(k)}}{: ${lx(v)}} \\\\`
).join("\n")}
  }}
\end{itemize}
` : "";

    const endDoc = "\n\\end{document}\n";

    return preamble + heading + edBlock + exBlock + prBlock + skBlock + endDoc;
  }, [html]);

  // copy handler
  async function copyLatex() {
    try {
      await navigator.clipboard.writeText(latex);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      console.error(e);
    }
  }

  // --------------- UI ----------------
  if (loading) return <div style={S.shell}><div style={S.card}>Loading…</div></div>;
  if (err && !showLatex) return (
    <div style={S.shell}>
      <div style={S.card}>
        <p style={{color:"#f99"}}>{err}</p>
        <p><Link to="/app" style={S.link}>← Back</Link></p>
      </div>
    </div>
  );

  const isHtml = (doc?.contentType || "").startsWith("text/html");

  return (
    <div style={S.shell}>
      <div style={{...S.card, maxWidth: "min(1100px, 96vw)", position:"relative"}}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
          <h2 style={{margin:0}}>Viewer</h2>
          <div style={{display:"flex", gap:14, alignItems:"center"}}>
            {isHtml && (
              <button
                onClick={loadHtmlForLatex}
                style={S.linkBtn}
                title="Get LaTeX"
              >
                ⎘ Get&nbsp;LaTeX
              </button>
            )}
            <button onClick={() => nav("/app")} style={S.linkGhost}>← Back</button>
          </div>
        </div>

        <div style={{marginTop:10, color:"#9aa6be", fontSize:13}}>
          {doc?.s3Key} • {doc?.contentType} • {doc?.documentId}
        </div>

        {/* ✅ Use the presigned URL directly; no fetch() */}
        {doc?.url && (
          <div style={{marginTop:16, height: "80vh"}}>
            <iframe
              title="Document"
              src={doc.url}
              style={{width:"100%", height:"100%", border:"0", borderRadius:12}}
            />
          </div>
        )}

        {/* Fallback open link */}
        {doc?.url && (
          <div style={{marginTop:12}}>
            <a href={doc.url} target="_blank" rel="noreferrer" style={S.btn}>
              Open in new tab
            </a>
          </div>
        )}
      </div>

      {/* LaTeX side panel */}
      {showLatex && (
        <div style={S.side}>
          <div style={S.sideHead}>
            <strong>LaTeX (Jake template)</strong>
            <div style={{display:"flex", gap:8}}>
              <button onClick={copyLatex} style={S.sideBtn} disabled={!latex}>
                {copied ? "Copied ✓" : (latex ? "Copy" : "No HTML")}
              </button>
              <button onClick={() => setShowLatex(false)} style={S.sideBtn}>Close</button>
            </div>
          </div>
          <textarea
            readOnly
            value={latex || (err ? `% ${err}` : "% Click Get LaTeX first")}
            spellCheck={false}
            style={S.codebox}
          />
          <div style={{fontSize:12, color:"#a9b4d0", marginTop:8}}>
            Tip: The generated LaTex output may not perfectly align with any spacing/grouping parsing that was shown on your original resume. You might need to adjust syntax accordingly.
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- styles ----------
const S = {
  shell: { background:"#0b1220", minHeight:"100vh", padding:"24px" },
  card: {
    background:"rgba(18,26,43,0.92)", border:"1px solid #1f2a44",
    borderRadius:16, padding:20, margin:"0 auto", maxWidth:900
  },
  link: { color:"#98b7ff", textDecoration:"none" },
  btn: {
    background:"#2fe6a7", border:"1px solid #2fe6a7", color:"#06291f",
    padding:"10px 12px", borderRadius:10, textDecoration:"none", fontWeight:600
  },
  linkBtn: {
    background:"transparent", color:"#98b7ff",
    border:"1px solid #2b3a64", borderRadius:10, padding:"6px 10px",
    cursor:"pointer"
  },
  linkGhost: {
    background:"transparent", color:"#a9b4d0",
    border:"1px solid #2b3a64", borderRadius:10, padding:"6px 10px",
    cursor:"pointer"
  },
  side: {
    position:"fixed", right:16, top:16, bottom:16, width:"min(640px, 48vw)",
    background:"rgba(18,26,43,0.98)", border:"1px solid #1f2a44", borderRadius:14,
    padding:12, display:"flex", flexDirection:"column", zIndex:40,
    boxShadow:"0 18px 60px rgba(0,0,0,.45)"
  },
  sideHead: {
    display:"flex", justifyContent:"space-between", alignItems:"center",
    color:"#e6eaf2", marginBottom:8
  },
  sideBtn: {
    background:"#0f1626", color:"#e6eaf2", border:"1px solid #2b3a64",
    borderRadius:8, padding:"6px 10px", cursor:"pointer"
  },
  codebox: {
    flex:"1 1 auto", width:"100%", resize:"none",
    background:"#0b1220", color:"#e6eaf2",
    border:"1px solid #233056", borderRadius:10, padding:12,
    fontFamily:"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize:13, lineHeight:1.4, whiteSpace:"pre"
  }
};

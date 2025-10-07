import base64
import boto3
import botocore
import decimal
import html as htmlmod
import io
import json
import json as _json
import mimetypes
import os
import re
import socket
import ssl
import time
import urllib.error
import urllib.request
import uuid

from boto3.dynamodb.conditions import Key, Attr
from pypdf import PdfReader

# ------------------ Config ------------------
MAX_DOCS_PER_USER = 10  # keep in sync with UI
ALLOWED_EXTS = ("pdf", "doc", "docx", "txt")
REGION = os.environ.get("AWS_REGION", "us-east-2")


# Tunables for OpenAI HTTP call (env overrideable)
OPENAI_HTTP_TIMEOUT = float(os.environ.get("OPENAI_HTTP_TIMEOUT", "18.0"))  # seconds per call
OPENAI_MAX_RETRIES  = int(os.environ.get("OPENAI_MAX_RETRIES", "1"))       # 0 or 1 is sensible here

# Hard cap all network ops (urllib + sockets)
socket.setdefaulttimeout(12)


# ------------------ Utils ------------------
def _resp(code, obj):
    def _json_default(o):
        if isinstance(o, decimal.Decimal):
            return int(o) if o % 1 == 0 else float(o)
        raise TypeError(f"Object of type {o.__class__.__name__} is not JSON serializable")
    # IMPORTANT: Only Content-Type. No CORS headers here.
    return {
        "statusCode": code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(obj, default=_json_default),
    }

def _extract_pdf_text(data: bytes, max_chars: int = 20000) -> str:
    """Best-effort text extraction for 'application/pdf' using pypdf."""
    try:
        reader = PdfReader(io.BytesIO(data))
        if getattr(reader, "is_encrypted", False):
            try:
                reader.decrypt("")  # try empty password
            except Exception:
                return "[PDF is encrypted; text not extracted]"
        out = []
        for page in reader.pages:
            out.append(page.extract_text() or "")
            if sum(len(x) for x in out) > max_chars * 1.1:
                break
        text = "\n".join(out).strip()
        return text[:max_chars] if text else "[PDF had no extractable text]"
    except Exception as e:
        return f"[Could not extract PDF text: {e}]"

def _get_env(name):
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"Missing required env var: {name}")
    return v

BUCKET = _get_env("BUCKET_NAME")
APPL_TABLE = boto3.resource("dynamodb").Table(_get_env("APPL_TABLE"))
DOCS_TABLE = boto3.resource("dynamodb").Table(_get_env("DOCS_TABLE"))
s3 = boto3.client("s3", region_name=REGION)

def _get_body(event):
    body = event.get("body")
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode()
    try:
        return json.loads(body or "{}")
    except json.JSONDecodeError:
        raise ValueError("Request body must be valid JSON.")

def _basename(key: str) -> str:
    return key.rsplit("/", 1)[-1] if "/" in key else key

def _ext(filename: str) -> str:
    return filename.lower().rsplit(".", 1)[-1] if "." in filename else ""

def _now() -> int:
    return int(time.time())

def _get_text_from_url(url: str, timeout=5) -> str:
    """Fetch visible text from a webpage using stdlib only (no external deps)."""
    if not url:
        return "[No job URL provided]"
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "ResumeAssistantBot/1.0 (+https://example.com)"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            html = r.read().decode("utf-8", "ignore")
        # strip script/style
        html = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", html)
        # drop tags
        text = re.sub(r"(?s)<[^>]+>", " ", html)
        text = htmlmod.unescape(" ".join(text.split()))
        return text[:20000] if text else "[Fetched page had no visible text]"
    except Exception as e:
        return f"[Could not fetch JD: {e}]"

def _find_doc_by_id(user_id: str, document_id: str):
    """Try GetItem on (userId, documentId); fall back to Scan if schema differs."""
    try:
        res = DOCS_TABLE.get_item(Key={"userId": user_id, "documentId": document_id})
        item = res.get("Item")
        if item:
            return item
    except botocore.exceptions.ClientError:
        pass
    scan = DOCS_TABLE.scan(
        Limit=1,
        FilterExpression=(Attr("userId").eq(user_id) & Attr("documentId").eq(document_id))
    )
    items = scan.get("Items", [])
    return items[0] if items else None

def _count_docs_for_user(user_id: str) -> int:
    try:
        resp = DOCS_TABLE.query(
            KeyConditionExpression=Key("userId").eq(user_id),
            Select="COUNT"
        )
        return int(resp.get("Count", 0))
    except botocore.exceptions.ClientError as e:
        err = e.response.get("Error", {}).get("Code")
        msg = e.response.get("Error", {}).get("Message", "")
        if err == "ValidationException" or "Query condition missed key schema" in msg:
            total = 0
            scan_kwargs = {"FilterExpression": Attr("userId").eq(user_id), "Select": "COUNT"}
            while True:
                resp = DOCS_TABLE.scan(**scan_kwargs)
                total += int(resp.get("Count", 0))
                if "LastEvaluatedKey" not in resp:
                    break
                scan_kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
            return total
        raise

CONTACT_EMAIL_RE = re.compile(r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}", re.I)
CONTACT_PHONE_RE = re.compile(r"(?:(?:\+?\d{1,3}[\s\-\.])?(?:\(?\d{3}\)?[\s\-\.])?\d{3}[\s\-\.]\d{4})")
LINK_RE = re.compile(r"(?:https?://|www\.)\S+", re.I)

def _extract_contact_bits(resume_text: str):
    """Grab first non-empty line as name; also pull email/phone/links if present."""
    text = (resume_text or "").strip()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    name = ""
    if lines:
        for ln in lines[:6]:
            if not re.search(r"education|experience|projects|skills", ln, re.I):
                name = ln
                break
    email = CONTACT_EMAIL_RE.search(text)
    phone = CONTACT_PHONE_RE.search(text)
    links = LINK_RE.findall(text)
    seen = set()
    uniq_links = []
    for u in links:
        if u not in seen:
            uniq_links.append(u); seen.add(u)
    return {"name": name[:120], "email": (email.group(0) if email else ""),
            "phone": (phone.group(0) if phone else ""), "links": uniq_links[:5]}

def _ensure_invariants_present(html: str, invariants: dict) -> bool:
    if not html: return False
    ok = True
    if invariants.get("name"):
        ok = ok and (invariants["name"].lower() in html.lower())
    if invariants.get("email"):
        ok = ok and (invariants["email"].lower() in html.lower())
    return ok

SECTION_CANON = [
    "header","summary","objective","skills","technical skills","experience",
    "work experience","professional experience","projects","education",
    "certifications","awards","publications","activities","volunteering",
]

def _normalize_heading(h: str) -> str:
    h = h.strip(" \t:-•—").strip()
    return " ".join(h.split())

def _looks_like_heading(line: str) -> bool:
    s = line.strip()
    if len(s) > 80 or len(s) < 3:
        return False
    if s.endswith(":"): s = s[:-1]
    words = s.split()
    if len(words) <= 6 and (s.isupper() or s.istitle()):
        return True
    return s.lower() in SECTION_CANON

def _detect_section_order(resume_text: str) -> list[str]:
    order, seen = [], set()
    for raw in (resume_text or "").splitlines():
        if _looks_like_heading(raw):
            h = _normalize_heading(raw)
            k = h.lower().rstrip(":")
            if k not in seen:
                order.append(h); seen.add(k)
    dedup, seen2 = [], set()
    for h in order:
        k = h.lower().rstrip(":")
        if k not in seen2:
            dedup.append(h); seen2.add(k)
    return dedup[:12]

# ---------- Tailor: produce FULL HTML resume with guardrails ----------
def _ai_tailor_resume_html(resume_text: str, job_text: str, interests: str) -> str:
    invariants = _extract_contact_bits(resume_text)
    section_order = _detect_section_order(resume_text)
    api_key = os.environ.get("OPENAI_API_KEY")

    if not api_key:
        safe_resume = (resume_text or "").replace("<", "&lt;").replace(">", "&gt;")
        return f"""<!doctype html>
<html lang="en"><meta charset="utf-8" />
<title>Tailored Resume (AI disabled)</title>
<style>
body{{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b1220;color:#e6eaf2;margin:24px}}
.card{{background:#121a2b;border:1px solid #223154;border-radius:14px;padding:22px;max-width:900px;margin:auto}}
h1,h2{{margin:0 0 10px}} h1{{font-size:28px}} h2{{font-size:18px;margin-top:22px}} ul{{margin:8px 0 0 18px}}
.muted{{color:#9aa6be;font-size:13px}}
li{{color:#fff}}
</style>
<div class="card">
<h1>{htmlmod.escape(invariants.get("name") or "Your Name")}</h1>
<div class="muted">{htmlmod.escape(invariants.get("email") or "")} {htmlmod.escape(invariants.get("phone") or "")}</div>
<p class="muted">{' • '.join(map(htmlmod.escape, invariants.get("links", [])))}</p>
<h2>Original (not parsed)</h2>
<pre style="white-space:pre-wrap">{safe_resume}</pre>
</div>
</html>"""

    # Header invariants for the prompt
    invariant_lines = []
    if invariants.get("name"):
        invariant_lines.append(f"- Name: {invariants['name']}")
    if invariants.get("email"):
        invariant_lines.append(f"- Email: {invariants['email']}")
    if invariants.get("phone"):
        invariant_lines.append(f"- Phone: {invariants['phone']}")
    if invariants.get("links"):
        invariant_lines.append("- Links: " + ", ".join(invariants["links"]))
    invariant_block = "\n".join(invariant_lines) or "- (no explicit header invariants found)"

    # Order helpers
    order_display = " > ".join(section_order) if section_order else "(not detected)"
    order_strict = [h.lower().rstrip(":") for h in section_order] if section_order else []

    # CSS (define before we might use it in error path)
    css = (
        "<style>\n"
        "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b1220;color:#e6eaf2;margin:24px}\n"
        ".card{background:#121a2b;border:1px solid #223154;border-radius:14px;padding:22px;max-width:900px;margin:auto}\n"
        "h1,h2{margin:0 0 10px} h1{font-size:28px} h2{font-size:18px;margin-top:22px}\n"
        "ul{margin:8px 0 0 18px}\n"
        "li{color:#fff}\n"
        "</style>\n"
    )

    # Build the prompt
    system = (
        "You are a precise, ATS-friendly resume editor.\n"
        "HARD RULES:\n"
        "• Do NOT invent or change facts: company names, job titles, locations, date ranges, degrees, school names.\n"
        "• Keep the original EXPERIENCE role scaffolding (employer/title/location/dates) exactly.\n"
        "• Rewrite ONLY the bullet points to emphasize JD keywords; keep counts similar (3–6/role) and realistic.\n"
        "• If a field is missing in the source, omit it rather than fabricating.\n"
        "• Output a COMPLETE, valid HTML document (<!doctype html>…</html>) with modest inline CSS. No code fences.\n"
        "• Bullets (<li>) must render with white text (set inline CSS or parent style).\n"
        "• **Preserve the original SECTION ORDER exactly as provided.**"
    )
    user = (
        "Produce a tailored resume as HTML.\n\n"
        "HEADER INVARIANTS (must appear verbatim if present; omit blank lines):\n"
        f"{invariant_block}\n\n"
        "ORIGINAL SECTION ORDER (must be preserved as-is, including unfamiliar/custom sections):\n"
        f"{order_display}\n\n"
        "Normalized order keys (for strict compliance):\n"
        f"{order_strict}\n\n"
        "EXPERIENCE INVARIANTS:\n"
        "- Read the Experience section in the RESUME TEXT and copy employer names, job titles, locations, and date ranges EXACTLY as written.\n"
        "- Rewrite only the bullets under each role; incorporate JD keywords naturally without keyword-stuffing.\n\n"
        "STYLE:\n"
        "- Sections present in the source must appear in the SAME ORDER. Do not add new sections unless present in the source.\n"
        "- Concise, metric-oriented bullets where authentic.\n"
        "- Use <ul><li> for bullets and ensure <li> text is white via CSS.\n\n"
        "RESUME TEXT (raw/extracted, may be partial):\n"
        "-----\n" + (resume_text or "")[:20000] + "\n-----\n\n"
        "JOB DESCRIPTION (sanitized):\n"
        "-----\n" + (job_text or "")[:20000] + "\n-----\n\n"
        f"Candidate interests/keywords: {interests or '(none)'}\n"
    )

    # Minimal HTTP client for OpenAI
    def _http_chat_completion(api_key: str, model: str, system_msg: str, user_msg: str, timeout_sec: float) -> str:
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_msg},
                {"role": "user", "content": user_msg}
            ],
            "temperature": 0.15,
        }
        data = _json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=data,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "User-Agent": "ResumeAssistantBot/1.0"
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout_sec) as r:
            status = getattr(r, "status", None) or r.getcode()
            body = r.read()
        if status != 200:
            raise RuntimeError(f"openai_http_status={status} body={body[:200]!r}")
        resp = _json.loads(body.decode("utf-8", "ignore"))
        return (resp.get("choices", [{}])[0].get("message", {}).get("content", "") or "").strip()

    def _order_ok(_html: str) -> bool:
        if not section_order:
            return True
        pos = -1
        text_l = _html.lower()
        for h in section_order:
            idx = text_l.find(_normalize_heading(h).lower().rstrip(":"))
            if idx == -1 or idx < pos:
                return False
            pos = idx
        return True

    def _call_once(prompt_user: str, per_call_timeout: float):
        try:
            print("[tailor] calling OpenAI (urllib)…")
            html = _http_chat_completion(
                api_key=api_key,
                model="gpt-4o-mini",
                system_msg=system,
                user_msg=prompt_user,
                timeout_sec=per_call_timeout,
            )
            print("[tailor] OpenAI response ok (urllib)")
            if not html:
                raise RuntimeError("empty completion")
        except Exception as e:
            safe = htmlmod.escape(str(e))
            print(f"[tailor] OpenAI error: {e}")
            return (
                "<!doctype html><html><head>"+css+"</head>"
                "<body><div class='card'>"
                "<h2>Tailor error</h2>"
                "<p class='muted'>OpenAI request failed or timed out.</p>"
                "<pre>"+safe+"</pre></div></body></html>"
            )

        if "<!doctype" not in html.lower():
            html = "<!doctype html>\n" + html
        if "<style" not in html.lower():
            if "<head>" in html:
                html = html.replace("<head>", "<head>\n"+css)
            else:
                body_part = html if "<html" not in html.lower() else ""
                html = f"<!doctype html><html><head>{css}</head><body>{body_part or html}</body></html>"
        elif "li{color" not in html:
            html = html.replace("</style>", "li{color:#fff}\n</style>")
        return html

    # Attempt 1
    html = _call_once(user, OPENAI_HTTP_TIMEOUT)

    # Retry once if it missed invariants/order (and caller allows)
    if (OPENAI_MAX_RETRIES > 0) and (not _ensure_invariants_present(html, invariants) or not _order_ok(html)):
        print("[tailor] retrying due to invariant/order check or previous error")
        time.sleep(0.3)
        retry_user = user + (
            "\n\nIMPORTANT: Your previous draft missed invariants and/or original section order. Regenerate and:\n"
            "- Include header invariants verbatim if present.\n"
            "- Keep EXACT section order as listed; do not rename or reorder sections.\n"
            "- Keep employer/title/location/date scaffolding exactly; only rewrite bullets."
        )
        html2 = _call_once(retry_user, OPENAI_HTTP_TIMEOUT)
        if _ensure_invariants_present(html2, invariants) and _order_ok(html2):
            html = html2

    return html

# ------------------ Diagnostics ------------------
def handle_diag():
    out = {"ok": True, "steps": []}
    # Step A: raw TCP/SSL to api.openai.com:443
    try:
        t0 = time.time()
        sock = socket.create_connection(("api.openai.com", 443), timeout=5)
        ctx = ssl.create_default_context()
        with ctx.wrap_socket(sock, server_hostname="api.openai.com"):
            out["steps"].append({"tcp_tls": "ok", "rtt_ms": int((time.time()-t0)*1000)})
    except Exception as e:
        out["ok"] = False
        out["steps"].append({"tcp_tls": f"error: {e}"})
    # Step B: HTTPS GET /v1/models with your key
    try:
        req = urllib.request.Request(
            "https://api.openai.com/v1/models",
            headers={"Authorization": f"Bearer {os.environ.get('OPENAI_API_KEY','')}"}
        )
        with urllib.request.urlopen(req, timeout=6) as r:
            status = getattr(r, "status", None) or r.getcode()
            out["steps"].append({"models_http_status": status})
    except Exception as e:
        out["ok"] = False
        out["steps"].append({"models_error": str(e)})
    return _resp(200 if out["ok"] else 500, out)

def handle_get_document_html(event):
    """GET /documents/html?userId=...&documentId=... -> returns the HTML body itself.
       This avoids S3 CORS because the browser talks only to the Lambda URL."""
    qs = event.get("queryStringParameters") or {}
    user_id = (qs.get("userId") or "demo").strip()
    doc_id  = (qs.get("documentId") or "").strip()

    if not (user_id and doc_id):
        return _resp(400, {"error": "Missing userId or documentId"})

    item = _find_doc_by_id(user_id, doc_id)
    if not item:
        return _resp(404, {"error": "Document not found"})

    if not str(item.get("contentType","")).startswith("text/html"):
        return _resp(415, {"error": "Document is not text/html"})

    key = item.get("s3Key")
    if not key:
        return _resp(500, {"error": "Document missing s3Key"})

    try:
        obj = s3.get_object(Bucket=BUCKET, Key=key)
        body_bytes = obj["Body"].read()
    except Exception as e:
        return _resp(500, {"error": "Failed to read S3 object", "detail": str(e)})

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "text/html; charset=utf-8"},
        "body": body_bytes.decode("utf-8", "replace"),
    }


# ------------------ HTTP entry ------------------
def lambda_handler(event, context):
    method = (event.get("requestContext", {}).get("http", {}).get("method")
              or event.get("httpMethod", "GET")).upper()
    path = event.get("rawPath") or event.get("path", "/")

    while path.startswith("//"):
        path = path[1:]
    if path.endswith("/") and path != "/":
        path = path[:-1]

    # ✅ Proper preflight
    if method == "OPTIONS":
        return {"statusCode": 200, "body": ""}

    if method == "GET" and path == "/health":
        return _resp(200, {"ok": True, "service": "resume-assistant"})

    if method == "GET" and path == "/diag":
        return handle_diag()

    if method == "POST" and path in ("/score", "/match/score"):
        body = _get_body(event)
        resume = set(map(str.lower, body.get("resumeSkills", [])))
        required = set(map(str.lower, body.get("requiredSkills", [])))
        coverage = len(resume & required) / max(1, len(required))
        score = round(coverage, 3)
        return _resp(200, {"score": score, "coverage": coverage})

    if method == "POST" and path == "/upload/resume":
        return handle_upload_resume(_get_body(event))

    if method == "POST" and path == "/applications":
        return handle_create_application(_get_body(event))

    if method == "GET" and path == "/documents":
        return handle_list_documents(event)

    if method in ("DELETE", "POST") and path == "/documents/delete":
        return handle_delete_document(event)

    if method == "POST" and path == "/tailor":
        return handle_tailor(event)
    
    if method == "GET" and path == "/documents/html":
        return handle_get_document_html(event)


    return _resp(404, {"error": "Not found", "path": path, "method": method})

# ------------------ Routes ------------------
def handle_upload_resume(body):
    user_id = (body.get("userId") or "demo").strip()
    filename = (body.get("filename") or f"resume-{uuid.uuid4()}.txt").strip()
    content_b64 = body.get("contentBase64")
    if not (user_id and filename and content_b64):
        return _resp(400, {"error": "Fields required: userId, filename, contentBase64"})

    ext = _ext(filename)
    if ext not in ALLOWED_EXTS:
        return _resp(415, {"error": "Unsupported file type. Allowed: PDF, DOC, DOCX, TXT"})

    try:
        if _count_docs_for_user(user_id) >= MAX_DOCS_PER_USER:
            return _resp(429, {"error": f"Doc limit reached ({MAX_DOCS_PER_USER})."})
    except Exception:
        pass

    try:
        data = base64.b64decode(content_b64)
    except Exception:
        return _resp(400, {"error": "contentBase64 is not valid base64"})

    if len(data) > 10 * 1024 * 1024:
        return _resp(413, {"error": "File too large (>10MB)"})

    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    key = f"resumes/{user_id}/{filename}"

    try:
        s3.put_object(Bucket=BUCKET, Key=key, Body=data,
                      ContentType=content_type, ContentDisposition="inline")
    except botocore.exceptions.ClientError as e:
        return _resp(500, {"error": "Upload failed", "detail": str(e)})

    doc_id = str(uuid.uuid4())
    now = _now()
    DOCS_TABLE.put_item(Item={
        "userId": user_id,
        "documentId": doc_id,
        "type": "resume_original",
        "s3Key": key,
        "contentType": content_type,
        "size": len(data),
        "createdAt": now
    })

    url = s3.generate_presigned_url(
        "get_object", Params={"Bucket": BUCKET, "Key": key}, ExpiresIn=300
    )

    return _resp(200, {
        "ok": True, "documentId": doc_id, "bucket": BUCKET, "s3Key": key,
        "size": len(data), "contentType": content_type, "createdAt": now, "url": url
    })

def handle_create_application(body):
    item = {
        "userId": (body.get("userId") or "demo").strip(),
        "jobId": body.get("jobId") or str(uuid.uuid4()),
        "score": body.get("score", 0),
        "status": body.get("status", "CREATED"),
        "createdAt": _now()
    }
    APPL_TABLE.put_item(Item=item)
    return _resp(200, item)

def handle_list_documents(event):
    qs = event.get("queryStringParameters") or {}
    user_id = (qs.get("userId") or "demo").strip()
    items = []
    try:
        resp = DOCS_TABLE.query(
            KeyConditionExpression=Key("userId").eq(user_id),
            Limit=100, ScanIndexForward=False
        )
        items = resp.get("Items", [])
    except botocore.exceptions.ClientError as e:
        err = e.response.get("Error", {}).get("Code")
        msg = e.response.get("Error", {}).get("Message", "")
        if err == "ValidationException" or "Query condition missed key schema" in msg:
            resp = DOCS_TABLE.scan(Limit=100, FilterExpression=Attr("userId").eq(user_id))
            items = resp.get("Items", [])
        else:
            return _resp(500, {"error": "DynamoDB query failed", "detail": str(e)})

    for it in items:
        try:
            it["url"] = s3.generate_presigned_url(
                "get_object", Params={"Bucket": BUCKET, "Key": it["s3Key"]}, ExpiresIn=300
            )
        except Exception:
            pass

    return _resp(200, {"items": items, "count": len(items)})

def handle_delete_document(event):
    body = {}
    if event.get("body"):
        try:
            b = event["body"]
            if event.get("isBase64Encoded"):
                b = base64.b64decode(b).decode()
            body = json.loads(b or "{}")
        except Exception:
            body = {}
    qs = event.get("queryStringParameters") or {}
    user_id = (body.get("userId") or qs.get("userId") or "demo").strip()
    document_id = (body.get("documentId") or qs.get("documentId") or "").strip()
    explicit_key = (body.get("s3Key") or qs.get("s3Key") or "").strip()

    if not (user_id and (document_id or explicit_key)):
        return _resp(400, {"error": "Fields required: userId AND (documentId OR s3Key)"})

    item = None
    if not explicit_key:
        try:
            res = DOCS_TABLE.get_item(Key={"userId": user_id, "documentId": document_id})
            item = res.get("Item")
            if not item:
                scan = DOCS_TABLE.scan(
                    Limit=1,
                    FilterExpression=(Attr("userId").eq(user_id) & Attr("documentId").eq(document_id))
                )
                if scan.get("Items"):
                    item = scan["Items"][0]
        except botocore.exceptions.ClientError as e:
            return _resp(500, {"error": "DynamoDB read failed", "detail": str(e)})

        if not item:
            return _resp(200, {"ok": True, "message": "Document not found; nothing to delete"})
        explicit_key = item.get("s3Key", "")

    s3_deleted = False
    if explicit_key:
        try:
            s3.delete_object(Bucket=BUCKET, Key=explicit_key)
            s3_deleted = True
        except botocore.exceptions.ClientError as e:
            err = e.response.get("Error", {}).get("Code", "")
            if err not in ("NoSuchKey", "AccessDenied"):
                return _resp(500, {"error": "S3 delete failed", "detail": str(e)})

    ddb_deleted = False
    try:
        if item:
            DOCS_TABLE.delete_item(Key={"userId": item["userId"], "documentId": item["documentId"]})
            ddb_deleted = True
        elif document_id:
            DOCS_TABLE.delete_item(Key={"userId": user_id, "documentId": document_id})
            ddb_deleted = True
    except botocore.exceptions.ClientError as e:
        return _resp(500, {"error": "DynamoDB delete failed", "detail": str(e)})

    return _resp(200, {
        "ok": True, "s3Deleted": s3_deleted, "ddbDeleted": ddb_deleted,
        "s3Key": explicit_key, "userId": user_id,
        "documentId": document_id or (item.get("documentId") if item else None)
    })

def handle_tailor(event):
    """
    Body: { userId, documentId, jobUrl, interests }
    Produces an HTML resume and stores to S3 under resumes/{userId}/tailored/*.html
    """
    print("[tailor] start")
    body = _get_body(event)
    user_id = (body.get("userId") or "demo").strip()
    source_doc_id = (body.get("documentId") or "").strip()
    job_url = (body.get("jobUrl") or "").strip()
    interests = (body.get("interests") or "").strip()
    print("[tailor] input", {"userId": user_id, "docId": source_doc_id})

    if not (user_id and source_doc_id and job_url):
        return _resp(400, {"error": "Fields required: userId, documentId, jobUrl"})

    try:
        if _count_docs_for_user(user_id) >= MAX_DOCS_PER_USER:
            return _resp(429, {"error": f"Document limit reached ({MAX_DOCS_PER_USER})"})
    except Exception:
        pass

    item = _find_doc_by_id(user_id, source_doc_id)
    if not item:
        return _resp(404, {"error": "Source document not found", "documentId": source_doc_id})

    src_key = item.get("s3Key")
    src_ct = item.get("contentType", "application/octet-stream")
    if not src_key:
        return _resp(400, {"error": "Source item missing s3Key"})

    resume_text = ""
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=src_key)
        data = obj["Body"].read()
        print("[tailor] fetched resume bytes", {"ct": src_ct, "len": len(data)})
        if src_ct == "application/pdf" or data.startswith(b"%PDF"):
            resume_text = _extract_pdf_text(data)
        elif src_ct.startswith("text/") or src_ct in ("application/json", "application/xml"):
            resume_text = data.decode("utf-8", errors="replace")[:20000]
        else:
            resume_text = f"[Original content-type {src_ct} not parsed]"
    except Exception as e:
        print("[tailor] error reading resume", str(e))
        resume_text = "[Could not fetch original resume bytes]"

    job_text = _get_text_from_url(job_url)
    print("[tailor] fetched job text len", len(job_text))

    print("[tailor] calling _ai_tailor_resume_html")
    html = _ai_tailor_resume_html(resume_text, job_text, interests)
    print("[tailor] got html len", len(html))
    html_bytes = html.encode("utf-8")

    base = _basename(src_key).rsplit(".", 1)[0]
    now = int(time.time())
    html_key = f"resumes/{user_id}/tailored/{base}__tailored_{now}.html"

    try:
        s3.put_object(
            Bucket=BUCKET, Key=html_key, Body=html_bytes,
            ContentType="text/html; charset=utf-8",
            ContentDisposition="inline", CacheControl="no-cache",
            ServerSideEncryption="AES256",
            Metadata={
                "type": "resume_tailored",
                "sourcedocumentid": source_doc_id,
                "joburl": job_url,
                "interests": interests or "",
            },
        )
        print("[tailor] wrote html to s3", {"key": html_key, "size": len(html_bytes)})
    except botocore.exceptions.ClientError as e:
        return _resp(500, {"error": "S3 put failed", "detail": str(e)})

    new_doc_id = str(uuid.uuid4())
    DOCS_TABLE.put_item(Item={
        "userId": user_id,
        "documentId": new_doc_id,
        "type": "resume_tailored",
        "s3Key": html_key,
        "contentType": "text/html",
        "size": len(html_bytes),
        "sourceDocumentId": source_doc_id,
        "jobUrl": job_url,
        "interests": interests or "",
        "createdAt": now,
    })
    print("[tailor] indexed in ddb", {"docId": new_doc_id})

    url = s3.generate_presigned_url(
        "get_object", Params={"Bucket": BUCKET, "Key": html_key}, ExpiresIn=300,
    )
    print("[tailor] done")
    return _resp(200, {
        "ok": True,
        "documentId": new_doc_id,
        "s3Key": html_key,
        "createdAt": now,
        "type": "resume_tailored",
        "url": url,
        "contentType": "text/html",
    })

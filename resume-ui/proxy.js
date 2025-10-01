// proxy.js
import express from "express";
import fetch from "node-fetch";
import aws4 from "aws4";
import { URL } from "url";
import { fromIni } from "@aws-sdk/credential-providers";

const app = express();
app.use(express.json({ limit: "12mb" }));

// CORS so the Vite app can call the proxy
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "http://localhost:5173");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// Load AWS creds from your default profile (or set AWS_PROFILE)
const getCreds = fromIni({ profile: process.env.AWS_PROFILE }); // e.g. export AWS_PROFILE=default

const TARGET = "https://kuwewg6au3kjt6wia54cincyra0baepn.lambda-url.us-east-2.on.aws";

app.use(async (req, res) => {
  try {
    const u = new URL(req.originalUrl, TARGET);
    const opts = {
      host: u.host,
      path: u.pathname + (u.search || ""),
      service: "lambda",
      region: "us-east-2",
      method: req.method,
      headers: { "Content-Type": req.get("content-type") || "application/json" },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body ?? {})
    };

    // Explicitly sign with creds from ~/.aws/credentials
    const { accessKeyId, secretAccessKey, sessionToken } = await getCreds();
    aws4.sign(opts, { accessKeyId, secretAccessKey, sessionToken });

    const rsp = await fetch(`${u.origin}${opts.path}`, opts);
    const text = await rsp.text();
    res.status(rsp.status)
       .set("content-type", rsp.headers.get("content-type") || "application/json")
       .send(text);
  } catch (e) {
    res.status(500).json({ error: "proxy_error", detail: String(e) });
  }
});

app.listen(5174, () => console.log("Signing proxy on http://localhost:5174"));


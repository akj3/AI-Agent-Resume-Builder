// src/Landing.jsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function Landing() {
  const [exiting, setExiting] = useState(false);
  const navigate = useNavigate();

  const go = () => {
    setExiting(true);
    setTimeout(() => navigate("/app"), 450);
  };

  // Inline safety styles for the container and layers
  const S = {
    root: {
      position: "relative",
      minHeight: "100vh",
      width: "100%",
      display: "grid",
      placeItems: "center",
      background: "#0b0e14",
      overflow: "hidden",
      transition: "opacity .45s ease, filter .45s ease",
      zIndex: 0,
    },
    exit: { opacity: 0, filter: "blur(6px)" },
    inner: {
      position: "relative",
      zIndex: 3,
      textAlign: "center",
      padding: "0 24px",
      maxWidth: 1100,
      color: "#e8ebf5",
    },
    title: {
      margin: "0 0 10px",
      fontSize: "clamp(44px, 7.2vw, 92px)",
      fontWeight: 700,
      letterSpacing: ".2px",
      color: "#e8ebf5",
    },
    sub: {
      margin: "0 0 28px",
      fontSize: "clamp(16px, 2.2vw, 22px)",
      color: "#b6c0d9",
    },
    btn: {
      border: "1px solid rgba(255,255,255,.18)",
      background: "rgba(15,17,24,.75)",
      color: "#fff",
      padding: "12px 22px",
      borderRadius: 10,
      fontWeight: 600,
      letterSpacing: ".2px",
      cursor: "pointer",
      boxShadow: "0 8px 28px rgba(0,0,0,.35)",
      transition:
        "transform .18s ease, box-shadow .18s ease, background .25s ease, border-color .25s ease",
      backdropFilter: "blur(6px) saturate(120%)",
    },
    btnHover: {
      transform: "translateY(-1px)",
      borderColor: "rgba(255,255,255,.35)",
      background: "rgba(20,22,30,.85)",
      boxShadow: "0 12px 36px rgba(0,0,0,.45)",
    },
    glow: {
      position: "absolute",
      inset: 0,
      margin: "auto",
      width: "min(70vw, 800px)",
      height: "min(70vw, 800px)",
      borderRadius: "50%",
      filter: "blur(60px)",
      opacity: 0.9,
      zIndex: 1,
      pointerEvents: "none",
      animation: "glow-pulse 9s ease-in-out infinite",
      background:
        "radial-gradient(closest-side at 50% 50%, rgba(18,180,255,.9), transparent 60%)," +
        "radial-gradient(closest-side at 65% 40%, rgba(155,111,255,.7), transparent 60%)," +
        "radial-gradient(closest-side at 35% 60%, rgba(255,111,170,.6), transparent 60%)," +
        "radial-gradient(closest-side at 50% 50%, rgba(255,212,121,.4), transparent 60%)",
    },
  };

  return (
    <main
      className={`landing ${exiting ? "landing-exit" : ""}`}
      style={{ ...S.root, ...(exiting ? S.exit : null) }}
    >
      <div className="landing-glow" style={S.glow} aria-hidden />
      <div className="landing-inner" style={S.inner}>
        <h1 className="landing-title" style={S.title}>
          Arber&apos;s Resume Builder
        </h1>
        <p className="landing-sub" style={S.sub}>
          AI for building your ideal resume
        </p>
        <button
          className="landing-cta"
          onClick={go}
          style={S.btn}
          onMouseEnter={(e) =>
            Object.assign(e.currentTarget.style, S.btnHover)
          }
          onMouseLeave={(e) => Object.assign(e.currentTarget.style, S.btn)}
        >
          Build your perfect resume
        </button>
      </div>
    </main>
  );
}

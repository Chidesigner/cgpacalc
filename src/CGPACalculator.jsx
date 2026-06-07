import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import { usePaystackPayment } from "react-paystack";

/* ─── SUPABASE CONFIG ─────────────────────────────────────── */
const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL      || "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const supabase          = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const BANK     = { name: "Uma Benjamin Chidi", number: "9166054611", bank: "OPay" };
const WHATSAPP = "2348084775815";

/* ─── HASH ────────────────────────────────────────────────── */
const hashPin = async (p) => {
  const buf = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(p + "cgpa_salt_ng_2025"));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
};

/* ─── SAFE JSON PARSE ─────────────────────────────────────── */
const safeParseJson = (raw, fallback = {}) => {
  if (raw == null) return fallback;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return fallback; }
  }
  return fallback;
};

/* ─── DB LAYER ────────────────────────────────────────────── */
const DB = {
  async getUser(reg) {
    const { data, error } = await supabase
      .from("users").select("*")
      .eq("reg_no", reg.toUpperCase().trim()).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },
  async userExists(reg) {
    const { data } = await supabase
      .from("users").select("reg_no")
      .eq("reg_no", reg.toUpperCase().trim()).maybeSingle();
    return !!data;
  },
  async createUser(reg, pinHash) {
    const { error } = await supabase.from("users").insert({
      reg_no: reg.toUpperCase().trim(), pin_hash: pinHash,
      status: "pending", semesters_data: {}, updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
  },
  async hasReceipt(reg) {
    const { data } = await supabase.from("receipts").select("reg_no")
      .eq("reg_no", reg.toUpperCase().trim()).limit(1).maybeSingle();
    return !!data;
  },
  async saveSemesters(reg, semesters) {
    const payload = typeof semesters === "string" ? JSON.parse(semesters) : semesters;
    const { error } = await supabase.from("users")
      .update({ semesters_data: payload, updated_at: new Date().toISOString() })
      .eq("reg_no", reg.toUpperCase().trim());
    if (error) throw new Error(error.message);
  },
  async uploadReceipt(reg, file) {
    const ext  = file.name.split(".").pop();
    const path = `${reg.toUpperCase().trim()}/${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage.from("receipts")
      .upload(path, file, { upsert: true });
    if (upErr) throw new Error(upErr.message);
    const { error: dbErr } = await supabase.from("receipts")
      .insert({ reg_no: reg.toUpperCase().trim(), receipt_url: path });
    if (dbErr) throw new Error(dbErr.message);
    return path;
  },
};

/* ─── SHARED CONSTANTS ────────────────────────────────────── */
const GRADE_OPTS = ["A","B","C","D","E","F"];
const POINT_OPTS = ["1","2","3","4","6"];
const SESSIONS = Array.from({length:30},(_,i)=>`${2010+i}/${2011+i}`);
const LEVELS     = ["100","200","300","400","500","600"];
const SEMS       = ["First Semester","Second Semester"];
const IT_ELIGIBLE_LEVELS = new Set(["300","400","500","600"]);

const blankCourse = (sn) => ({ sn: sn ? String(sn) : "", grade: "", points: "", isIT: false, itGrade: "", itUnits: "" });

/* ─── GRADE ENGINE ────────────────────────────────────────── */
const GRADES = { A:5, B:4, C:3, D:2, E:1, F:0 };
const gradePoint = (grade) => GRADES[grade?.toUpperCase()] ?? 0;

const computeGPA = (courses) => {
  const rows = [];
  courses.forEach(c => {
    if (c.sn && c.grade && c.points && !(c.isIT && !c.grade))
      rows.push({ gp: gradePoint(c.grade), units: Number(c.points) });
    if (c.isIT && c.itGrade && c.itUnits && Number(c.itUnits) > 0)
      rows.push({ gp: gradePoint(c.itGrade), units: Number(c.itUnits) });
  });
  if (!rows.length) return null;
  const totalWeighted = rows.reduce((s,r) => s + r.gp * r.units, 0);
  const totalUnits    = rows.reduce((s,r) => s + r.units, 0);
  return totalUnits > 0 ? +(totalWeighted / totalUnits).toFixed(4) : null;
};

const computeCGPA = (semesters) => computeGPA(semesters.flatMap(s => s.courses || []));

const classify = (cgpa) => {
  if (cgpa == null) return null;
  if (cgpa >= 4.50) return { label: "First Class Honours",      short: "1st",  color: "#059669" };
  if (cgpa >= 3.50) return { label: "Second Class Upper (2:1)", short: "2:1",  color: "#0284c7" };
  if (cgpa >= 2.40) return { label: "Second Class Lower (2:2)", short: "2:2",  color: "#7c3aed" };
  if (cgpa >= 1.50) return { label: "Third Class",              short: "3rd",  color: "#d97706" };
  return               { label: "Pass",                         short: "Pass", color: "#dc2626" };
};

const fmt = (n) => n != null ? Number(n).toFixed(2) : "—";
const gradeColor = (g) => ({ A:"#059669", B:"#0284c7", C:"#7c3aed", D:"#d97706", E:"#ea580c", F:"#dc2626" }[g?.toUpperCase()] || "#64748b");

/* ─── COUNTDOWN ───────────────────────────────────────────── */
const useCountdown = () => {
  const [t, setT] = useState(() => {
    const stored = sessionStorage.getItem("cgpa_deadline");
    if (stored) {
      const deadline = parseInt(stored);
      const diff = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
      return { h: Math.floor(diff/3600), m: Math.floor((diff%3600)/60), s: diff%60 };
    }
    // Set a real deadline 7h 23m 41s from now
    const deadline = Date.now() + (7*3600 + 23*60 + 41) * 1000;
    sessionStorage.setItem("cgpa_deadline", String(deadline));
    return { h:7, m:23, s:41 };
  });
  useEffect(() => {
    const id = setInterval(() => {
      const stored = sessionStorage.getItem("cgpa_deadline");
      if (!stored) return;
      const deadline = parseInt(stored);
      const diff = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
      setT({ h: Math.floor(diff/3600), m: Math.floor((diff%3600)/60), s: diff%60 });
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return `${String(t.h).padStart(2,"0")}:${String(t.m).padStart(2,"0")}:${String(t.s).padStart(2,"0")}`;
};

/* ─── COPY HOOK ───────────────────────────────────────────── */
const useCopy = () => {
  const [copied, setCopied] = useState(false);
  const copy = (text) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    });
  };
  return [copied, copy];
};

/* ─── INTERSECTION OBSERVER HOOK (scroll animations) ─────── */
const useInView = (threshold = 0.15) => {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setInView(true); obs.disconnect(); }
    }, { threshold });
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return [ref, inView];
};

/* ─── PDF EXPORT ──────────────────────────────────────────── */
const generateTranscriptPDF = async (regNo, savedList, cgpa) => {
  if (!window.jspdf) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      script.onload = resolve; script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = 210; const H = 297;
  const cl = classify(cgpa);
  const now = new Date();
  const PAD = 18; // left/right margin

  // ── BACKGROUND: clean white ───────────────────────────────
  doc.setFillColor(255, 255, 255);
  doc.rect(0, 0, W, H, "F");

  // ── TOP ACCENT BAR (thin) ─────────────────────────────────
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, W, 14, "F");

  // Brand name left
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(255, 255, 255);
  doc.text("CGPACalc", PAD, 9.5);

  // Date right
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.5);
  doc.setTextColor(148, 163, 184);
  doc.text(
    `Generated ${now.toLocaleDateString("en-NG", { dateStyle: "long" })}`,
    W - PAD, 9.5, { align: "right" }
  );

  // ── HEADER BLOCK ──────────────────────────────────────────
  let y = 26;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.5);
  doc.setTextColor(150, 150, 150);
  doc.text("ACADEMIC TRANSCRIPT SUMMARY", PAD, y);
  y += 6;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(15, 23, 42);
  doc.text(regNo, PAD, y);
  y += 4;

  // Thin divider
  doc.setDrawColor(230, 230, 230);
  doc.setLineWidth(0.4);
  doc.line(PAD, y, W - PAD, y);
  y += 8;

  // ── CGPA + CLASS ROW ──────────────────────────────────────
  // Left: CGPA number
  doc.setFont("helvetica", "bold");
  doc.setFontSize(36);
  const clRgb =
    cl?.color === "#059669" ? [5,150,105] :
    cl?.color === "#0284c7" ? [2,132,199] :
    cl?.color === "#7c3aed" ? [124,58,237] :
    cl?.color === "#d97706" ? [217,119,6]  : [220,38,38];
  doc.setTextColor(...clRgb);
  doc.text(fmt(cgpa), PAD, y + 10);

  // Right: classification label + stats
  const allCourses = savedList.flatMap(s => s.courses || []);
  const totalUnits = allCourses.reduce((a,c) => a + Number(c.points||0) + (c.isIT && c.itUnits ? Number(c.itUnits) : 0), 0);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text(cl?.label || "", W - PAD, y + 4, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(130, 130, 130);
  doc.text(`${savedList.length} semesters  ·  ${totalUnits} credit units  ·  5-point scale`, W - PAD, y + 10, { align: "right" });

  y += 18;

  // Divider
  doc.setDrawColor(230, 230, 230);
  doc.setLineWidth(0.4);
  doc.line(PAD, y, W - PAD, y);
  y += 8;

  // ── SEMESTER TABLE ────────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(6);
  doc.setTextColor(150, 150, 150);
  doc.text("SEMESTER BREAKDOWN", PAD, y);
  y += 5;

  // Column header row
  doc.setFillColor(248, 248, 248);
  doc.rect(PAD, y, W - PAD * 2, 7, "F");

  const COL = {
    level:   PAD + 2,
    sem:     PAD + 22,
    session: PAD + 62,
    units:   PAD + 108,
    gpa:     PAD + 128,
    cls:     PAD + 148,
  };

  doc.setFont("helvetica", "bold");
  doc.setFontSize(5.5);
  doc.setTextColor(130, 130, 130);
  [["LEVEL", COL.level], ["SEMESTER", COL.sem], ["SESSION", COL.session],
   ["UNITS", COL.units], ["GPA", COL.gpa], ["CLASS", COL.cls]
  ].forEach(([label, x]) => doc.text(label, x, y + 4.8));
  y += 7;

  const semOrder = (s) => (parseInt(s.level)||0) * 10 + (s.sem === "First Semester" ? 0 : 1);
  const sorted = [...savedList].sort((a, b) => semOrder(a) - semOrder(b));

  sorted.forEach((sem, i) => {
    const rowH = 8;
    if (i % 2 === 1) {
      doc.setFillColor(252, 252, 252);
      doc.rect(PAD, y, W - PAD * 2, rowH, "F");
    }

    const cl2 = classify(sem.gpa);
    const rgb2 =
      cl2?.color === "#059669" ? [5,150,105] :
      cl2?.color === "#0284c7" ? [2,132,199] :
      cl2?.color === "#7c3aed" ? [124,58,237] :
      cl2?.color === "#d97706" ? [217,119,6]  : [220,38,38];

    // Left accent bar
    if (cl2) { doc.setFillColor(...rgb2); doc.rect(PAD, y, 1.5, rowH, "F"); }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.5);
    doc.setTextColor(15, 23, 42);
    doc.text(`${sem.level}L`, COL.level, y + 5.2);

    doc.setFont("helvetica", "normal");
    doc.setTextColor(80, 80, 80);
    doc.text(sem.sem === "First Semester" ? "First" : "Second", COL.sem, y + 5.2);
    doc.text(sem.session || "—", COL.session, y + 5.2);

    const units = (sem.courses||[]).reduce((a,c) => a + Number(c.points||0) + (c.isIT && c.itUnits ? Number(c.itUnits) : 0), 0);
    doc.text(String(units), COL.units, y + 5.2);

    doc.setFont("helvetica", "bold");
    doc.setTextColor(...rgb2);
    doc.text(fmt(sem.gpa), COL.gpa, y + 5.2);

    doc.setFont("helvetica", "normal");
    doc.setTextColor(130, 130, 130);
    doc.text(cl2?.short || "—", COL.cls, y + 5.2);

    doc.setDrawColor(240, 240, 240);
    doc.setLineWidth(0.2);
    doc.line(PAD, y + rowH, W - PAD, y + rowH);

    y += rowH;
  });

  y += 8;

  // ── GRADING SCALE (compact inline) ───────────────────────
  doc.setDrawColor(230, 230, 230);
  doc.setLineWidth(0.4);
  doc.line(PAD, y, W - PAD, y);
  y += 6;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(6);
  doc.setTextColor(150, 150, 150);
  doc.text("GRADING SCALE", PAD, y);
  y += 4;

  const scaleItems = [
    ["A", "70-100", "5.0", [5,150,105]],
    ["B", "60-69",  "4.0", [2,132,199]],
    ["C", "50-59",  "3.0", [124,58,237]],
    ["D", "45-49",  "2.0", [217,119,6]],
    ["E", "40-44",  "1.0", [234,88,12]],
    ["F", "0-39",   "0.0", [220,38,38]],
  ];
  const scaleColW = (W - PAD * 2) / scaleItems.length;
  scaleItems.forEach(([g, range, pts, rgb], i) => {
    const sx = PAD + i * scaleColW;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...rgb);
    doc.text(g, sx, y + 5);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(5);
    doc.setTextColor(130, 130, 130);
    doc.text(`${range} · ${pts}pts`, sx, y + 9);
  });
  y += 14;

  // ── CLASSIFICATION BOUNDARIES ─────────────────────────────
  doc.setDrawColor(230, 230, 230);
  doc.setLineWidth(0.4);
  doc.line(PAD, y, W - PAD, y);
  y += 6;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(6);
  doc.setTextColor(150, 150, 150);
  doc.text("DEGREE CLASSIFICATION", PAD, y);
  y += 5;

  const classes = [
    ["First Class",             ">= 4.50",    [5,150,105]],
    ["Second Class Upper (2:1)","3.50 - 4.49",[2,132,199]],
    ["Second Class Lower (2:2)","2.40 - 3.49",[124,58,237]],
    ["Third Class",             "1.50 - 2.39",[217,119,6]],
    ["Pass",                    "< 1.50",     [220,38,38]],
  ];

  // Draw all 5 inline as two columns
  classes.forEach(([cls, range, rgb], i) => {
    const col = i < 3 ? PAD : PAD + 90;
    const row = i < 3 ? i : i - 3;
    const rowY = y + row * 7;

    doc.setFillColor(...rgb);
    doc.circle(col + 1.5, rowY - 0.8, 1.2, "F");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(6);
    doc.setTextColor(15, 23, 42);
    doc.text(cls, col + 5, rowY);

    doc.setFont("helvetica", "normal");
    doc.setTextColor(130, 130, 130);
    doc.text(range, col + 60, rowY);
  });

  y += 24;

  // ── FOOTER ────────────────────────────────────────────────
  doc.setFillColor(15, 23, 42);
  doc.rect(0, H - 16, W, 16, "F");

  doc.setFont("helvetica", "normal");
  doc.setFontSize(6);
  doc.setTextColor(100, 116, 139);
  doc.text(
    "CGPACalc · cgpacalc.ng · For personal academic planning only. Not an official university transcript.",
    W / 2, H - 9, { align: "center" }
  );
  doc.text(
    `ID: CGPA-${regNo.replace(/[^A-Z0-9]/g,"")}-${Date.now().toString(36).toUpperCase()}`,
    W / 2, H - 5, { align: "center" }
  );

  doc.save(`CGPACalc_${regNo.replace(/\//g,"-")}.pdf`);
};

/* ═══════════════════════════════════════════════════════════
   IT PANEL COMPONENT
═══════════════════════════════════════════════════════════ */
const ITPanelInline = ({ course, index, onUpdate, onMarkChanged, onRemoveIT }) => {
  const { itGrade, itUnits } = course;
  const handleGrade = (g) => { onUpdate(index, "itGrade", itGrade === g ? "" : g); onMarkChanged(); };
  const handleUnits = (e) => {
    const v = e.target.value.replace(/[^0-9]/g, "");
    const capped = v === "" ? "" : String(Math.min(30, Math.max(1, parseInt(v) || 1)));
    onUpdate(index, "itUnits", capped); onMarkChanged();
  };
  const isComplete = itGrade && itUnits && Number(itUnits) > 0;

  return (
    <div style={IT.panel} className="it-panel-enter">
      <div style={IT.panelHeader}>
        <span style={IT.panelIcon}>🏭</span>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={IT.panelTitle}>Industrial Training (IT/SIWES)</div>
          <div style={IT.panelSub}>Course {course.sn||"—"} · Enter IT grade and credit units</div>
        </div>
        {isComplete && (
          <div style={IT.completeBadge}>
            <span style={{ color:gradeColor(itGrade), fontWeight:800, fontFamily:"var(--mono)" }}>{itGrade}</span>
            <span style={{ color:"#64748b", fontSize:"0.65rem", marginLeft:3 }}>· {itUnits}u</span>
          </div>
        )}
        <button onClick={onRemoveIT} title="Remove IT mode" style={{ background:"#fef2f2", border:"1.5px solid #fecaca", borderRadius:6, color:"#ef4444", cursor:"pointer", width:28, height:28, display:"flex", alignItems:"center", justifyContent:"center", fontSize:"0.9rem", fontWeight:800, flexShrink:0, marginLeft:6, touchAction:"manipulation" }}>✕</button>
      </div>
      <div style={IT.fieldBlock}>
        <label style={IT.fieldLabel}>IT Grade</label>
        <div style={IT.gradeRow} className="it-grade-row">
          {GRADE_OPTS.map(g => (
            <button key={g} className="it-grade-btn" style={{ ...IT.gradeBtn, background:itGrade===g?gradeColor(g):"#f8fafc", color:itGrade===g?"#fff":gradeColor(g), border:`2px solid ${itGrade===g?gradeColor(g):"#e2e8f0"}`, fontWeight:itGrade===g?800:500, transform:itGrade===g?"scale(1.08)":"scale(1)" }} onClick={() => handleGrade(g)}>{g}</button>
          ))}
        </div>
      </div>
      <div style={IT.fieldBlock}>
        <label style={IT.fieldLabel}>Credit Units Allocated to IT</label>
        <div style={IT.unitsRow}>
          <input type="number" inputMode="numeric" pattern="[0-9]*" min={1} max={30} placeholder="e.g. 6" value={itUnits} onChange={handleUnits} style={IT.unitsInput} />
          <div style={IT.unitsHint}><span style={{ color:"#94a3b8", fontSize:"0.72rem" }}>Typically 3–15 units. Check your handbook.</span></div>
        </div>
        <div style={IT.quickChips} className="it-quick-chips">
          {["3","4","6","8","10","12","15"].map(v => (
            <button key={v} style={{ ...IT.chip, background:itUnits===v?"#0f172a":"#f1f5f9", color:itUnits===v?"#fff":"#64748b", border:`1.5px solid ${itUnits===v?"#0f172a":"#e2e8f0"}` }} onClick={() => { onUpdate(index, "itUnits", v); onMarkChanged(); }}>{v}</button>
          ))}
        </div>
      </div>
      {isComplete && (
        <div style={IT.preview}>
          <span style={{ fontSize:"0.7rem", color:"#64748b" }}>IT contribution:</span>
          <span style={{ fontFamily:"var(--mono)", fontWeight:800, color:gradeColor(itGrade), marginLeft:8 }}>{itGrade} × {itUnits} units = {(gradePoint(itGrade)*Number(itUnits)).toFixed(1)} weighted points</span>
        </div>
      )}
    </div>
  );
};

const IT = {
  panel: { margin:"0 0 8px 0", background:"linear-gradient(135deg,#f5f3ff 0%,#faf5ff 100%)", border:"1.5px solid #ddd6fe", borderLeft:"4px solid #7c3aed", borderRadius:12, padding:"14px 14px 12px", animation:"itSlideIn 0.22s ease both" },
  panelHeader: { display:"flex", alignItems:"flex-start", gap:10, marginBottom:14 },
  panelIcon: { fontSize:"1.3rem", flexShrink:0, marginTop:1 },
  panelTitle: { fontWeight:800, fontSize:"0.82rem", color:"#4c1d95", lineHeight:1.3 },
  panelSub: { fontSize:"0.68rem", color:"#7c3aed", marginTop:2, lineHeight:1.4 },
  completeBadge: { marginLeft:"auto", background:"#fff", border:"1px solid #ddd6fe", borderRadius:20, padding:"3px 10px", fontSize:"0.72rem", display:"flex", alignItems:"center", flexShrink:0 },
  fieldBlock: { marginBottom:12 },
  fieldLabel: { display:"block", fontSize:"0.6rem", color:"#7c3aed", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:7 },
  gradeRow: { display:"flex", gap:7, flexWrap:"wrap" },
  gradeBtn: { width:42, height:42, borderRadius:8, cursor:"pointer", fontFamily:"var(--mono)", fontSize:"0.88rem", display:"flex", alignItems:"center", justifyContent:"center", transition:"all 0.12s", padding:0, flexShrink:0, touchAction:"manipulation" },
  unitsRow: { display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" },
  unitsInput: { width:90, border:"2px solid #ddd6fe", borderRadius:8, padding:"10px 12px", fontFamily:"var(--mono)", fontWeight:700, fontSize:"1.1rem", color:"#4c1d95", background:"#fff", textAlign:"center", flexShrink:0, outline:"none", WebkitAppearance:"none", MozAppearance:"textfield" },
  unitsHint: { flex:1, minWidth:0 },
  quickChips: { display:"flex", gap:6, flexWrap:"wrap", marginTop:8 },
  chip: { padding:"6px 12px", borderRadius:20, cursor:"pointer", fontFamily:"var(--mono)", fontSize:"0.75rem", fontWeight:700, transition:"all 0.1s", minHeight:32, display:"flex", alignItems:"center", touchAction:"manipulation" },
  preview: { background:"#ede9fe", border:"1px solid #c4b5fd", borderRadius:8, padding:"8px 12px", display:"flex", alignItems:"center", flexWrap:"wrap", gap:4, marginTop:4 },
};

/* ═══════════════════════════════════════════════════════════
   ANIMATED SECTION WRAPPER
═══════════════════════════════════════════════════════════ */
const Reveal = ({ children, delay = 0, style = {} }) => {
  const [ref, inView] = useInView();
  return (
    <div ref={ref} style={{ transition:`opacity 0.65s ease ${delay}ms, transform 0.65s ease ${delay}ms`, opacity: inView?1:0, transform: inView?"translateY(0)":"translateY(28px)", ...style }}>
      {children}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════
   LANDING PAGE — NUCLEAR EDITION
═══════════════════════════════════════════════════════════ */
const Landing = ({ cd, onRegister, onLogin }) => {
  const [vis, setVis] = useState(false);
  const [activeAccordion, setActiveAccordion] = useState(null);
  useEffect(() => { const id = setTimeout(() => setVis(true), 80); return () => clearTimeout(id); }, []);

  const pain = [
    { icon:"🔄", text:"You've calculated your CGPA three times and gotten three different answers. You don't know which one is right." },
    { icon:"📱", text:"You screenshot your result and do arithmetic with a headache at midnight. You tell yourself 'it's probably fine.'" },
    { icon:"😬", text:"You told your parents your CGPA. It felt like a guess. Because it was." },
    { icon:"🎓", text:"Your final year defence is coming. You need a 2:1. You don't know if you have one. You're scared to find out." },
    { icon:"📋", text:"You're applying for NYSC, a job, or postgrad. They want your transcript. You've been stalling." },
    { icon:"💭", text:"You're two semesters in and already carrying a wrong number in your head. Every decision since then has been built on a lie." },
  ];

  const features = [
    { icon:"⚡", title:"Instant. Accurate. Done.", desc:"Enter S/N, grade, units. That's literally it. Your real CGPA in under 60 seconds — no spreadsheet, no formula, no guessing." },
    { icon:"🎯", title:"Built for Nigerian universities", desc:"5-point scale. A=5, B=4, C=3, D=2, E=1, F=0. UNILAG, OAU, UNIBEN, UI, ABU, FUTA — all of them. IT/SIWES handled separately, exactly right." },
    { icon:"📄", title:"Downloadable Transcript PDF", desc:"One premium PDF — all your semesters, GPA per semester, final CGPA, degree class. Print it. Send it. Use it for NYSC, job applications, postgrad." },
    { icon:"📊", title:"Full breakdown, full picture", desc:"GPA per semester. Cumulative CGPA. Degree classification. Which grades are helping you. Which ones are dragging you down." },
    { icon:"🧪", title:"What-if simulator", desc:"'What do I need to score next semester to hit First Class?' Answer it in 10 seconds. Stop guessing. Start planning." },
    { icon:"♾️", title:"One payment. Every semester.", desc:"₦299 once. 100L through final year. No renewals, no subscriptions, no surprises. Your account exists until you graduate — and beyond." },
  ];

  const proofs = [
    { q:"I had been carrying the wrong CGPA for over a year. I was 0.4 points higher than I thought. I almost cried in the library.", name:"Adaeze O.", school:"UNILAG · 400L · Law" },
    { q:"My department couldn't tell me my exact CGPA after three weeks of asking. CGPACalc gave me the number in 30 seconds. I used the PDF for my NYSC registration that same day.", name:"Emeka T.", school:"OAU · Final Year · Engineering" },
    { q:"The IT/SIWES calculation alone was worth it. I had no idea how to factor my industrial training in. Now I do.", name:"Blessing N.", school:"UNIPORT · 300L · Computer Science" },
    { q:"₦299 for something I'll use every semester for the next three years? I spent more than that on recharge cards this week.", name:"Fatima A.", school:"ABU Zaria · 200L · Medicine" },
  ];

  const faqs = [
    { q:"Does it work for my university?", a:"Yes. CGPACalc uses the standard Nigerian 5-point scale (A=5, B=4, C=3, D=2, E=1, F=0), which is the official standard across virtually all Nigerian federal and state universities — UNILAG, OAU, UNIBEN, UI, FUTA, ABU, UNIPORT, LASU, and more. IT and SIWES courses are handled separately; you just specify the grade and units and it computes correctly within your semester GPA." },
    { q:"What exactly is the transcript PDF?", a:"After accessing the calculator, you can generate and download a clean, branded PDF summary showing all your semesters, GPA per semester, your overall CGPA, and degree class. It includes the grading scale reference and is formatted to look professional. It's not a replacement for your official university transcript, but it's the clearest personal academic summary you'll ever have — and it's included in your ₦299." },
    { q:"What if I make a mistake entering data?", a:"Edit or delete any entry at any time. Your data is saved to your account — so you can log back in from any device and update it whenever new results drop. Nothing is permanent until you decide it is." },
    { q:"How fast do I get access after paying?", a:"Usually within 30 minutes during the day. After you upload your receipt, there's a direct WhatsApp link to follow up immediately. Most approvals happen within minutes during active hours." },
    { q:"Why does it cost anything at all?", a:"Because running secure, persistent accounts on a database costs real money. ₦299 is about the price of a meat pie and a juice. It covers the infrastructure cost and ensures your data is stored safely — not deleted, not lost, not reset. You pay once and your account exists through your entire degree." },
  ];

  return (
    <div style={{ opacity:vis?1:0, transition:"opacity 0.5s ease", maxWidth:700, width:"100%" }}>

      {/* ── URGENCY BAR ─────────────────────────────────────── */}
      <div style={L.urgBar} className="urg-bar">
        <span style={L.urgDot} className="urg-dot" />
        <span style={{ fontFamily:"var(--mono)", fontSize:"0.72rem", color:"#1e293b" }}>
          Introductory price ends in&nbsp;
          <strong style={{ color:"#dc2626", fontFamily:"var(--mono)", fontVariantNumeric:"tabular-nums" }}>{cd}</strong>
          &nbsp;— then it's ₦2,000. Forever.
        </span>
      </div>

      {/* ── HERO ────────────────────────────────────────────── */}
      <div style={{ padding:"64px 0 0", textAlign:"center" }}>
        <div style={L.pill} className="hero-pill">For Nigerian University Students · 5-Point Scale</div>

        <h1 style={L.heroH} className="hero-h">
          You're carrying<br/>
          <span style={L.heroEm}>the wrong number.</span>
        </h1>

        <p style={L.heroSub}>
          Right now, your CGPA is probably wrong.<br/>
          Not because you're careless — because manual calculation is <em>designed to fail you</em>.<br/>
          One misread boundary. One forgotten unit. One wrong formula.<br/>
          And your entire academic identity is quietly, silently, off.
        </p>

        <div style={{ display:"flex", gap:14, justifyContent:"center", flexWrap:"wrap", marginBottom:48 }}>
          <div style={L.statCard} className="stat-card">
            <span style={L.statNum}>7 in 10</span>
            <span style={L.statTxt}>students have miscalculated their CGPA — often across a full class boundary</span>
          </div>
          <div style={L.statCard} className="stat-card">
            <span style={L.statNum}>₦299</span>
            <span style={L.statTxt}>once — to know the truth about your degree, every semester, forever</span>
          </div>
        </div>

        <button style={{ ...L.ctaBtn, maxWidth:480, margin:"0 auto 12px", display:"block" }} className="cta-btn-hero" onClick={onRegister}>
          Show Me My Real CGPA →
        </button>
        <div style={{ fontSize:"0.72rem", color:"#94a3b8", marginBottom:8 }}>
          <span style={{ color:"#dc2626", fontWeight:700 }}>⏱ {cd}</span> left at ₦299 · No subscription · Cancel anytime? There's nothing to cancel.
        </div>
      </div>

      {/* ── PAIN SECTION ────────────────────────────────────── */}
      <Reveal style={{ margin:"56px 0 0" }}>
        <div style={L.secLabel}>Does any of this sound familiar?</div>
        <div style={{ display:"grid", gap:10 }}>
          {pain.map((p,i) => (
            <Reveal key={i} delay={i * 60}>
              <div style={L.painCard} className="pain-card">
                <div style={L.painIcon}>{p.icon}</div>
                <span style={{ fontSize:"0.92rem", color:"#374151", lineHeight:1.7 }}>{p.text}</span>
              </div>
            </Reveal>
          ))}
        </div>
        <div style={{ marginTop:20, background:"#fef2f2", border:"1px solid #fecaca", borderLeft:"4px solid #dc2626", borderRadius:12, padding:"14px 18px" }}>
          <p style={{ fontSize:"0.88rem", color:"#991b1b", lineHeight:1.75, fontWeight:500 }}>
            The worst part? You won't know your CGPA is wrong until it matters most. Until results day. Until the job application. Until they ask you to prove it. <strong>By then, it's too late to fix.</strong>
          </p>
        </div>
      </Reveal>

      {/* ── PRODUCT BOX ─────────────────────────────────────── */}
      <Reveal style={{ margin:"56px 0 0" }}>
        <div style={L.productBox}>
          <div style={L.secLabel}>The fix — built for you</div>
          <div style={L.prodName}>CGPACalc</div>
          <p style={{ fontSize:"0.97rem", color:"#475569", lineHeight:1.85, marginBottom:10 }}>
            A CGPA calculator that actually works the way Nigerian grading works. Enter your serial number, grade, and credit units. Get your exact CGPA — with a semester-by-semester breakdown, a degree class prediction, and a what-if simulator that tells you exactly what you need to score to hit your target.
          </p>
          <p style={{ fontSize:"0.97rem", color:"#475569", lineHeight:1.85, marginBottom:28, fontWeight:600 }}>
            And because you'll need proof — for NYSC, for applications, for your own peace of mind — it generates a downloadable transcript summary PDF. Premium. Branded. Ready to use.
          </p>

          {/* PDF HIGHLIGHT */}
          <div style={L.pdfHighlight} className="pdf-highlight">
            <div style={{ fontSize:"2rem", marginBottom:8 }}>📄</div>
            <div style={{ fontWeight:800, fontSize:"1rem", color:"#0f172a", marginBottom:6 }}>Included: Downloadable Transcript Summary PDF</div>
            <p style={{ fontSize:"0.83rem", color:"#475569", lineHeight:1.7, marginBottom:0 }}>
              A clean, formal PDF showing all your semesters, GPA per semester, overall CGPA, and degree classification — formatted like an academic document. Download it. Print it. Attach it to an application. Show it to your parents. Use it for NYSC registration. It's yours, forever, for ₦299.
            </p>
          </div>

          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginTop:20 }} className="feat-grid">
            {features.map(({icon,title,desc}) => (
              <div key={title} style={L.featCard} className="feat-card">
                <div style={{ fontSize:"1.6rem", marginBottom:8 }}>{icon}</div>
                <div style={{ fontWeight:800, fontSize:"0.88rem", color:"#0f172a", marginBottom:5 }}>{title}</div>
                <div style={{ fontSize:"0.76rem", color:"#64748b", lineHeight:1.6 }}>{desc}</div>
              </div>
            ))}
          </div>
        </div>
      </Reveal>

      {/* ── SOCIAL PROOF ────────────────────────────────────── */}
      <Reveal style={{ margin:"56px 0 0" }}>
        <div style={L.secLabel}>Students who used it</div>
        <div style={{ display:"grid", gap:14 }}>
          {proofs.map(({q,name,school},i) => (
            <Reveal key={name} delay={i * 80}>
              <div style={L.proof} className="proof-card">
                <div style={{ fontSize:"2rem", color:"#e2e8f0", fontFamily:"Georgia, serif", lineHeight:1, marginBottom:8 }}>"</div>
                <p style={L.proofQ}>{q}</p>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:14, paddingTop:12, borderTop:"1px solid #f1f5f9" }}>
                  <span style={{ fontWeight:800, fontSize:"0.82rem", color:"#0f172a" }}>{name}</span>
                  <span style={{ fontSize:"0.72rem", color:"#94a3b8", fontFamily:"var(--mono)" }}>{school}</span>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </Reveal>

      {/* ── CTA BOX ─────────────────────────────────────────── */}
      <Reveal style={{ margin:"56px 0 0" }}>
        <div style={L.ctaBox} className="cta-box">
          <div style={L.secLabel}>Get access now. Before the price changes.</div>

          <h2 style={{ fontFamily:"var(--display)", fontSize:"2.2rem", color:"#0f172a", marginBottom:8, lineHeight:1.2 }}>
            Everything you need to know your CGPA.<br/>
            <span style={{ color:"#059669", fontStyle:"italic" }}>For less than a plate of jollof.</span>
          </h2>

          <p style={{ fontSize:"0.88rem", color:"#64748b", lineHeight:1.8, marginBottom:24, maxWidth:480, margin:"0 auto 24px" }}>
            Full CGPA tracking + semester breakdown + degree class + what-if simulator + <strong style={{ color:"#0f172a" }}>downloadable transcript PDF</strong> — every semester, until you graduate.
          </p>

          <div style={{ display:"flex", alignItems:"baseline", gap:14, justifyContent:"center", marginBottom:8 }}>
            <span style={{ fontFamily:"var(--mono)", fontSize:"1.2rem", color:"#94a3b8", textDecoration:"line-through" }}>₦2,000</span>
            <span style={{ fontFamily:"var(--display)", fontSize:"5rem", color:"#059669", lineHeight:1, fontWeight:700 }}>₦299</span>
            <span style={L.saveBadge}>85% OFF</span>
          </div>

          <div style={{ textAlign:"center", fontSize:"0.76rem", color:"#64748b", marginBottom:24 }}>
            <span style={{ background:"#fef2f2", color:"#dc2626", fontWeight:800, padding:"4px 10px", borderRadius:20, fontFamily:"var(--mono)" }}>⏱ {cd}</span>
            &nbsp; remaining at this price — it goes to ₦2,000 and stays there
          </div>

          <div style={{ maxWidth:460, margin:"0 auto" }}>
            <button style={L.ctaBtn} className="cta-btn-hero" onClick={onRegister}>
              Calculate My Real CGPA — ₦299 →
            </button>
            <button style={L.ghostBtn} onClick={onLogin}>Already registered? Log in →</button>
            <div style={L.trustRow} className="trust-row">
              <span>🔒 Manual OPay transfer</span><span>·</span>
              <span>⚡ Access in &lt;30 min</span><span>·</span>
              <span>📄 PDF included</span><span>·</span>
              <span>♾️ No subscription</span>
            </div>
          </div>
        </div>
      </Reveal>

      {/* ── FAQ ─────────────────────────────────────────────── */}
      <Reveal style={{ margin:"56px 0 0" }}>
        <div style={L.secLabel}>Questions</div>
        {faqs.map(({q,a}, i) => (
          <div key={q} style={{ ...L.faqItem, borderLeft: activeAccordion===i ? "3px solid #059669" : "3px solid transparent" }} onClick={() => setActiveAccordion(activeAccordion===i ? null : i)}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", cursor:"pointer" }}>
              <span style={{ fontWeight:700, fontSize:"0.92rem", color:"#0f172a", paddingRight:12 }}>{q}</span>
              <span style={{ color:"#059669", fontWeight:800, fontSize:"1.1rem", flexShrink:0, transition:"transform 0.2s", transform:activeAccordion===i?"rotate(45deg)":"rotate(0)" }}>+</span>
            </div>
            {activeAccordion===i && (
              <p style={{ marginTop:12, fontSize:"0.84rem", color:"#64748b", lineHeight:1.85, animation:"fadeUp 0.2s ease" }}>{a}</p>
            )}
          </div>
        ))}
      </Reveal>

      {/* ── FINAL BOTTOM CTA ────────────────────────────────── */}
      <Reveal style={{ margin:"56px 0 0" }}>
        <div style={{ textAlign:"center", padding:"40px 20px", background:"#0f172a", borderRadius:20, marginBottom:40 }}>
          <div style={{ fontSize:"0.65rem", color:"#64748b", letterSpacing:"0.2em", textTransform:"uppercase", marginBottom:12 }}>One more time, because it matters</div>
          <h2 style={{ fontFamily:"var(--display)", fontSize:"2rem", color:"#fff", lineHeight:1.3, marginBottom:12 }}>
            You will use your CGPA to get a job.<br/>
            To apply for postgrad. To register for NYSC.<br/>
            <span style={{ color:"#059669", fontStyle:"italic" }}>Make sure it's right.</span>
          </h2>
          <p style={{ fontSize:"0.85rem", color:"#64748b", lineHeight:1.75, marginBottom:28, maxWidth:420, margin:"0 auto 28px" }}>
            ₦299. One time. Every semester until you graduate — plus the transcript PDF to prove it.
          </p>
          <button style={{ ...L.ctaBtn, background:"#059669", maxWidth:420, margin:"0 auto", display:"block" }} className="cta-btn-hero" onClick={onRegister}>
            I'm Ready — Get My CGPA →
          </button>
          <div style={{ fontSize:"0.7rem", color:"#475569", marginTop:12 }}>
            <span style={{ color:"#dc2626", fontWeight:700, fontFamily:"var(--mono)" }}>{cd}</span> left at this price
          </div>
        </div>
      </Reveal>

      <div style={{ height:60 }} />
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════
   REGISTER
═══════════════════════════════════════════════════════════ */
const Register = ({ onBack, onSuccess }) => {
  const [reg,setReg]=useState(""); const [pin,setPin]=useState(""); const [pin2,setPin2]=useState("");
  const [err,setErr]=useState(""); const [loading,setLoading]=useState(false);

  const handle = async () => {
    if (!reg.trim()) { setErr("Enter your matriculation number."); return; }
    if (pin.length < 4) { setErr("Password must be at least 4 characters."); return; }
    if (pin !== pin2) { setErr("Passwords don't match."); return; }
    setLoading(true); setErr("");
    try {
      const [exists, hash] = await Promise.all([DB.userExists(reg), hashPin(pin)]);
      if (exists) { setErr("That reg number is already registered. Log in instead."); return; }
      await DB.createUser(reg, hash);
      onSuccess(reg.toUpperCase().trim(), { reg_no:reg.toUpperCase().trim(), status:"pending", semesters_data:{}, created_at:new Date().toISOString() });
    } catch(e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div style={F.wrap} className="page-enter form-card">
      <button style={F.back} onClick={onBack}>← Back</button>
      <div style={F.chip}>Step 1 of 2</div>
      <h2 style={F.h2}>Create your account</h2>
      <p style={F.sub}>Just your matric number and a password. That's all we need.</p>
      <Field label="Matriculation / Reg Number" placeholder="e.g. 2021/233550" value={reg} onChange={setReg} upper />
      <Field label="Create a password" type="password" placeholder="Min 4 characters" value={pin} onChange={setPin} />
      <Field label="Confirm password" type="password" placeholder="Repeat password" value={pin2} onChange={setPin2} />
      {err && <Err msg={err} />}
      <PrimaryBtn onClick={handle} loading={loading}>Create Account & Continue →</PrimaryBtn>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════
   LOGIN
═══════════════════════════════════════════════════════════ */
const Login = ({ onBack, onApproved, onPending, onTrial }) => {
  const [reg,setReg]=useState(""); const [pin,setPin]=useState("");
  const [err,setErr]=useState(""); const [loading,setLoading]=useState(false);

  const handle = async () => {
    if (!reg.trim() || !pin) { setErr("Fill in both fields."); return; }
    setLoading(true); setErr("");
    try {
      const [user, hash] = await Promise.all([DB.getUser(reg), hashPin(pin)]);
      if (!user) { setErr("No account found. Register first."); return; }
      if (user.pin_hash !== hash) { setErr("Wrong password."); return; }
      if (user.status === "approved") { onApproved(reg.toUpperCase().trim(), user); return; }
      const submitted = await DB.hasReceipt(reg);
      if (submitted) onPending(reg.toUpperCase().trim(), user);
      else onTrial(reg.toUpperCase().trim(), user);
    } catch(e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div style={F.wrap} className="page-enter form-card">
      <button style={F.back} onClick={onBack}>← Back</button>
      <div style={F.chip}>Welcome back</div>
      <h2 style={F.h2}>Log in</h2>
      <p style={F.sub}>Enter your reg number and password.</p>
      <Field label="Matriculation / Reg Number" placeholder="e.g. 2021/233550" value={reg} onChange={setReg} upper />
      <Field label="Password" type="password" placeholder="Your password" value={pin} onChange={setPin} />
      {err && <Err msg={err} />}
      <PrimaryBtn onClick={handle} loading={loading}>Log In →</PrimaryBtn>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════
   PENDING APPROVAL
═══════════════════════════════════════════════════════════ */
const PendingApproval = ({ regNo, onBack }) => {
  const waMsg = encodeURIComponent(`Hi! I paid ₦299 for CGPACalc and I'm checking on my access.\nReg No: ${regNo}\nThanks!`);
  return (
    <div style={F.wrap} className="page-enter form-card">
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:"3.2rem", marginBottom:18, display:"inline-block", animation:"float 3s ease-in-out infinite" }}>☕</div>
        <div style={F.chip}>Payment received</div>
        <h2 style={{ ...F.h2, marginBottom:10 }}>Your spot is reserved. <span style={{ color:"#059669", fontStyle:"italic" }}>We're on it.</span></h2>
        <p style={{ ...F.sub, marginBottom:22 }}>We've got your receipt and it's being reviewed. Approvals happen within <strong>30 minutes</strong> during the day — usually much faster.</p>
        <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:14, padding:"16px 20px", marginBottom:20 }}>
          <div style={{ fontSize:"0.62rem", color:"#94a3b8", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:6 }}>Account secured for</div>
          <div style={{ fontFamily:"var(--mono)", fontWeight:800, fontSize:"1.15rem", color:"#0f172a" }}>{regNo}</div>
          <div style={{ marginTop:8, fontSize:"0.75rem", color:"#64748b", lineHeight:1.65 }}>The moment your payment is confirmed, your account unlocks — full CGPA tracking, semester history, and your transcript PDF, ready immediately.</div>
        </div>
        <a href={`https://wa.me/${WHATSAPP}?text=${waMsg}`} target="_blank" rel="noreferrer" style={{ ...PAY.waBtn, display:"block", marginBottom:12 }}>💬 Ping us on WhatsApp — we'll confirm right away →</a>
        <button style={{ ...F.ghostBtn, width:"100%", display:"block" }} onClick={onBack}>← Back to login</button>
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════
   PAYMENT PAGE
═══════════════════════════════════════════════════════════ */
const Payment = ({ regNo, cd, onBack, onSuccess }) => {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [email, setEmail] = useState("");
  const [showEmailStep, setShowEmailStep] = useState(true);

  const config = {
    reference: `CGPA-${regNo.replace(/[^A-Z0-9]/g,"")}-${Date.now()}`,
    email: email,
    amount: 29900, // ₦299 in kobo
    publicKey: import.meta.env.VITE_PAYSTACK_PUBLIC_KEY,
    metadata: { reg_no: regNo },
  };

  const onPaystackSuccess = async (response) => {
    setLoading(true);
    try {
      // Auto-approve user in Supabase
      await supabase.from("users").update({
        status: "approved",
        approved_at: new Date().toISOString(),
        paystack_ref: response.reference,
      }).eq("reg_no", regNo.toUpperCase().trim());
      onSuccess();
    } catch(e) {
      setErr("Payment received but activation failed. Contact support with ref: " + response.reference);
    } finally {
      setLoading(false);
    }
  };

  const onPaystackClose = () => {
    // User closed popup without paying — do nothing
  };

  const PaystackButton = usePaystackPayment(config);

  const handleProceed = () => {
    if (!email.trim() || !email.includes("@")) {
      setErr("Enter a valid email address."); return;
    }
    setErr("");
    setShowEmailStep(false);
  };

  if (loading) return (
    <div style={F.wrap} className="page-enter form-card">
      <div style={{ textAlign:"center", padding:"40px 0" }}>
        <div style={{ fontSize:"2.5rem", marginBottom:16 }}>⚡</div>
        <div style={F.chip}>Activating your account</div>
        <h2 style={F.h2}>Almost there...</h2>
        <p style={F.sub}>Your payment was received. Activating your account now.</p>
      </div>
    </div>
  );

  return (
    <div style={F.wrap} className="page-enter form-card">
      <button style={F.back} onClick={onBack}>← Back to dashboard</button>
      <div style={F.chip}>Unlock full access</div>
      <h2 style={F.h2}>One payment. Your degree, sorted.</h2>

      {/* Urgency */}
      <div style={PAY.urgBox}>
        <div style={{ fontSize:"1.4rem" }}>⏱</div>
        <div>
          <div style={{ fontWeight:800, fontSize:"0.9rem", color:"#0f172a" }}>Offer expires in <span style={{ color:"#dc2626", fontFamily:"var(--mono)" }}>{cd}</span></div>
          <div style={{ fontSize:"0.75rem", color:"#64748b", marginTop:2 }}>After this, the price returns to ₦2,000 permanently.</div>
        </div>
      </div>

      {/* What they get */}
      <div style={{ marginBottom:24 }}>
        <div style={F.secLabel}>What ₦299 unlocks — forever</div>
        {[
          "✓  Every semester, every level — tracked and saved forever",
          "✓  CGPA calculated cumulatively across your entire degree",
          "✓  Semester-by-semester GPA breakdown",
          "✓  Degree classification shown in real time",
          "✓  What-if simulator: see what score you need",
          "✓  IT/SIWES courses handled correctly",
          "✓  Downloadable Transcript Summary PDF",
          "✓  Access from any device, anytime, forever",
        ].map(t => (
          <div key={t} style={{ fontSize:"0.87rem", color:"#374151", padding:"8px 0", borderBottom:"1px solid #f1f5f9", lineHeight:1.5 }}>{t}</div>
        ))}
      </div>

      <div style={PAY.priceRow}>
        <span style={{ fontFamily:"var(--mono)", fontSize:"1rem", color:"#94a3b8", textDecoration:"line-through" }}>₦2,000</span>
        <span style={{ fontFamily:"var(--display)", fontSize:"3.2rem", color:"#059669", lineHeight:1 }}>₦299</span>
        <span style={PAY.badge}>85% OFF</span>
      </div>

      {showEmailStep ? (
        <>
          <p style={{ fontSize:"0.82rem", color:"#64748b", marginBottom:10, lineHeight:1.6 }}>
            Enter your email to receive your payment receipt from Paystack.
          </p>
          <Field label="Email Address" type="email" placeholder="you@example.com" value={email} onChange={setEmail} />
          {err && <Err msg={err} />}
          <PrimaryBtn onClick={handleProceed}>Continue to Payment →</PrimaryBtn>
        </>
      ) : (
        <>
          <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:10, padding:"12px 16px", marginBottom:16, fontSize:"0.8rem", color:"#065f46" }}>
            ✓ Paying as <strong>{email}</strong> · <span style={{ color:"#059669", cursor:"pointer", textDecoration:"underline" }} onClick={() => setShowEmailStep(true)}>change</span>
          </div>
          {err && <Err msg={err} />}
          <button
            style={{ ...F.primaryBtn, background:"#059669", display:"flex", alignItems:"center", justifyContent:"center", gap:10 }}
            onClick={() => PaystackButton({ onSuccess: onPaystackSuccess, onClose: onPaystackClose })}
          >
            <span>🔒</span> Pay ₦299 Securely with Paystack →
          </button>
          <div style={{ textAlign:"center", fontSize:"0.68rem", color:"#94a3b8", marginTop:10 }}>
            Secured by Paystack · Card, Bank Transfer, USSD supported · Instant activation
          </div>
        </>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════
   SEMESTER FORM
═══════════════════════════════════════════════════════════ */
const SemesterForm = ({ semKey, level, sem, session, initCourses=[], onSave, onDelete, collapsed: initCollapsed=false }) => {
  const [courses,setCourses]=useState(() => initCourses.length ? initCourses : Array.from({length:5},(_,i)=>blankCourse(i+1)));
  const [collapsed,setCollapsed]=useState(initCollapsed);
  const [saving,setSaving]=useState(false); const [saved,setSaved]=useState(initCourses.length>0); const [err,setErr]=useState("");
  const allowIT = IT_ELIGIBLE_LEVELS.has(level);
  const prevSemKey = useRef(semKey);

  useEffect(() => {
    if (prevSemKey.current !== semKey) {
      prevSemKey.current = semKey;
      if (initCourses.length > 0) { setCourses(initCourses); setSaved(true); setCollapsed(true); }
    }
  }, [semKey, initCourses]);

  const update = (i,field,val) => setCourses(p => p.map((c,idx) => idx===i?{...c,[field]:val}:c));
  const addRow = () => { setCourses(p=>[...p,blankCourse(p.length+1)]); setSaved(false); };
  const removeRow = (i) => setCourses(p=>p.filter((_,idx)=>idx!==i));
  const markChanged = () => setSaved(false);
  const toggleIT = (i) => { setCourses(p=>p.map((c,idx)=>idx!==i?c:{...c,isIT:!c.isIT,itGrade:!c.isIT?c.itGrade:"",itUnits:!c.isIT?c.itUnits:""})); setSaved(false); };

  const valid = courses.filter(c => c.sn && ((c.grade&&c.points)||(c.isIT&&c.itGrade&&c.itUnits&&Number(c.itUnits)>0)));
  const gpa = computeGPA(valid); const cl = classify(gpa);
  const itCount = valid.filter(c=>c.isIT&&c.itGrade&&c.itUnits).length;

  const handleSave = async () => {
    if (!valid.length) { setErr("Add at least one complete course."); return; }
    setErr(""); setSaving(true);
    try { await onSave({ semKey, level, sem, session, courses:valid, gpa }); setSaved(true); setCollapsed(true); }
    catch(e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div style={DS.semBlock}>
      <div style={DS.semHeader} onClick={() => setCollapsed(c=>!c)}>
        <div style={{ display:"flex", alignItems:"center", gap:10, minWidth:0 }}>
          <span style={DS.semToggle}>{collapsed?"▶":"▼"}</span>
          <div style={{ minWidth:0 }}>
            <span style={{ fontWeight:700, fontSize:"0.88rem", color:"#0f172a" }}>{level}L · {sem}</span>
            <span style={{ fontSize:"0.72rem", color:"#94a3b8", marginLeft:8 }}>{session}</span>
          </div>
          {saved&&gpa!=null&&(<span style={{ ...DS.gpaBadge, background:cl.color+"18", color:cl.color, border:`1px solid ${cl.color}33`, flexShrink:0 }}>GPA {fmt(gpa)} · {cl.short}</span>)}
          {saved&&itCount>0&&(<span style={{ background:"#ede9fe", color:"#7c3aed", border:"1px solid #ddd6fe", borderRadius:20, padding:"2px 8px", fontSize:"0.62rem", fontFamily:"var(--mono)", fontWeight:700, flexShrink:0 }}>IT✓</span>)}
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center", flexShrink:0 }}>
          {saved&&<span style={DS.savedDot}>✓</span>}
          <button style={DS.deleteBtn} onClick={e=>{e.stopPropagation();onDelete(semKey);}}>×</button>
        </div>
      </div>

      {!collapsed && (
        <div style={DS.semBody}>
          {!allowIT && (
            <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:8, padding:"8px 12px", marginBottom:12, fontSize:"0.72rem", color:"#94a3b8", display:"flex", alignItems:"center", gap:6 }}>
              <span>ℹ️</span><span>IT/SIWES is available for 300L and above.</span>
            </div>
          )}
          <div style={DS.colHead}>
            <span style={{width:36,textAlign:"center",fontSize:"0.6rem"}}>S/N</span>
            <span style={{flex:1,fontSize:"0.6rem"}}>Grade</span>
            <span style={{width:allowIT?90:120,textAlign:"center",fontSize:"0.6rem"}}>Credit Units</span>
            {allowIT&&<span style={{width:50,textAlign:"center",fontSize:"0.6rem"}}>IT</span>}
            <span style={{width:24}}/>
          </div>

          {courses.map((c,i) => (
            <div key={i}>
              <div style={DS.courseRow} className="course-row-wrap">
                <input style={{...F.inp,width:36,textAlign:"center",padding:"8px 4px",fontSize:"0.85rem"}} className="sn-input" value={c.sn} onChange={e=>{update(i,"sn",e.target.value);markChanged();}} placeholder={String(i+1)} />
                {c.isIT ? (
                  <div style={{flex:1,display:"flex",alignItems:"center",gap:8}} className="grade-group">
                    <div style={{display:"flex",alignItems:"center",gap:8,background:"linear-gradient(135deg,#f5f3ff,#ede9fe)",border:"1.5px solid #c4b5fd",borderLeft:"3px solid #7c3aed",borderRadius:8,padding:"7px 12px",flex:1}}>
                      <span style={{fontSize:"0.9rem"}}>🏭</span>
                      <span style={{fontSize:"0.75rem",fontWeight:700,color:"#5b21b6"}}>IT/SIWES mode</span>
                      {c.itGrade&&c.itUnits?(<span style={{marginLeft:"auto",fontFamily:"var(--mono)",fontSize:"0.72rem",color:"#7c3aed",fontWeight:800}}>{c.itGrade} · {c.itUnits}u</span>):(<span style={{marginLeft:"auto",fontSize:"0.65rem",color:"#a78bfa"}}>fill below ↓</span>)}
                    </div>
                  </div>
                ) : (
                  <>
                    <div style={{flex:1,display:"flex",gap:3,flexWrap:"wrap"}} className="grade-group">
                      {GRADE_OPTS.map(g=>(<button key={g} className="grade-btn" style={{...DS.gradeBtn,background:c.grade===g?gradeColor(g):"#f8fafc",color:c.grade===g?"#fff":gradeColor(g),border:`2px solid ${c.grade===g?gradeColor(g):"#e2e8f0"}`,fontWeight:c.grade===g?800:500}} onClick={()=>{update(i,"grade",c.grade===g?"":g);markChanged();}}>{g}</button>))}
                    </div>
                    <div style={{display:"flex",gap:3,justifyContent:"flex-start",flexWrap:"wrap"}} className="unit-group">
                      {POINT_OPTS.map(p=>(<button key={p} className="pt-btn" style={{...DS.ptBtn,background:c.points===p?"#0f172a":"#f8fafc",color:c.points===p?"#fff":"#374151",border:`2px solid ${c.points===p?"#0f172a":"#e2e8f0"}`}} onClick={()=>{update(i,"points",c.points===p?"":p);markChanged();}}>{p}</button>))}
                    </div>
                  </>
                )}
                {allowIT&&!c.isIT&&(<button className="it-btn" style={{...DS.itBtn,background:"#f1f5f9",color:"#94a3b8",border:"2px solid #e2e8f0"}} onClick={()=>toggleIT(i)} title="Mark as IT/SIWES course">IT</button>)}
                <button className="x-btn" style={DS.xBtn} onClick={()=>removeRow(i)}>×</button>
              </div>
              {allowIT&&c.isIT&&(<ITPanelInline course={c} index={i} onUpdate={update} onMarkChanged={markChanged} onRemoveIT={()=>toggleIT(i)} />)}
            </div>
          ))}

          <button style={DS.addRowBtn} onClick={addRow}>+ Add course</button>

          {gpa!=null&&(
            <div style={DS.liveGPA}>
              <span style={{fontSize:"0.65rem",color:"#64748b",marginRight:8}}>Semester GPA</span>
              <span style={{fontFamily:"var(--display)",fontSize:"1.8rem",color:cl.color,fontWeight:700,marginRight:8,lineHeight:1}}>{fmt(gpa)}</span>
              <span style={{fontSize:"0.78rem",fontWeight:700,color:cl.color}}>{cl.label}</span>
              <span style={{marginLeft:"auto",fontSize:"0.68rem",color:"#94a3b8",fontFamily:"var(--mono)"}}>{valid.reduce((s,c)=>{let u=s+Number(c.points||0);if(c.isIT&&c.itUnits)u+=Number(c.itUnits);return u;},0)} units{itCount>0&&<span style={{color:"#7c3aed",marginLeft:4}}>incl. IT</span>}</span>
            </div>
          )}

          {err&&<div style={F.err}>{err}</div>}
          <button style={{...F.primaryBtn,marginTop:8,opacity:saving?0.6:1}} onClick={handleSave} disabled={saving}>{saving?"Saving…":saved?"Update Semester ✓":"Save Semester →"}</button>
        </div>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════
   ADD SESSION MODAL
═══════════════════════════════════════════════════════════ */
const AddSessionModal = ({ existing, onAdd, onClose, regNo }) => {
  // Extract entry year from reg number e.g. "2022/249550" → 2022
  const entryYear = (() => {
    const match = regNo?.match(/^(\d{4})/);
    if (match) {
      const yr = parseInt(match[1]);
      if (yr >= 2000 && yr <= 2040) return yr;
    }
    return null;
  })();

  const [level, setLevel] = useState("100");
  const [picked, setPicked] = useState(["First Semester"]);

  // Auto-derive session from level + entry year
  const derivedSession = (() => {
    if (!entryYear) return SESSIONS[9];
    const offset = (parseInt(level) / 100) - 1;
    const start = entryYear + offset;
    const end = start + 1;
    const candidate = `${start}/${end}`;
    return SESSIONS.includes(candidate) ? candidate : SESSIONS[9];
  })();

  const [session, setSession] = useState(derivedSession);

  // Update session whenever level changes
  useEffect(() => {
    setSession(derivedSession);
  }, [level, entryYear]);

  const existingKeys = new Set(existing.map(s => s.semKey));
  const toggleSem = (s) => setPicked(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s]);

  const handleAdd = () => {
    const toAdd = picked
      .filter(s => !existingKeys.has(`${level}__${s}__${session}`))
      .map(s => ({ semKey: `${level}__${s}__${session}`, level, sem: s, session, courses: [], gpa: null }));
    if (!toAdd.length) { onClose(); return; }
    onAdd(toAdd); onClose();
  };

  return (
    <div style={DS.modalOverlay} className="modal-overlay-mobile" onClick={onClose}>
      <div style={DS.modal} className="modal-sheet" onClick={e => e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <h3 style={{ fontFamily:"var(--display)", fontSize:"1.4rem", color:"#0f172a" }}>Add Session</h3>
          <button style={DS.xBtn} onClick={onClose}>×</button>
        </div>

        <label style={F.lbl}>Level</label>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:16 }}>
          {LEVELS.map(l => (
            <button key={l} style={{ ...DS.levelChip, background:level===l?"#0f172a":"#f8fafc", color:level===l?"#fff":"#374151", border:`2px solid ${level===l?"#0f172a":"#e2e8f0"}` }} onClick={() => setLevel(l)}>
              {l}L
            </button>
          ))}
        </div>

        <label style={F.lbl}>Academic Session</label>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
          <select style={{ ...F.sel, marginBottom:0, flex:1 }} value={session} onChange={e => setSession(e.target.value)}>
            {SESSIONS.map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        {entryYear && (
          <div style={{ fontSize:"0.68rem", color:"#059669", marginBottom:16, marginTop:4 }}>
            ✓ Auto-set from your reg number ({entryYear} entry · {level}L = {session})
          </div>
        )}
        {!entryYear && <div style={{ marginBottom:16 }} />}

        <label style={F.lbl}>Semesters to add</label>
        <div style={{ display:"flex", gap:8, marginBottom:24 }}>
          {SEMS.map(s => {
            const key = `${level}__${s}__${session}`;
            const already = existingKeys.has(key);
            return (
              <button key={s} style={{ ...DS.levelChip, flex:1, background:already?"#f1f5f9":picked.includes(s)?"#059669":"#f8fafc", color:already?"#94a3b8":picked.includes(s)?"#fff":"#374151", border:`2px solid ${already?"#e2e8f0":picked.includes(s)?"#059669":"#e2e8f0"}`, opacity:already?0.5:1, cursor:already?"not-allowed":"pointer" }} onClick={() => !already && toggleSem(s)} title={already?"Already added":""}>
                {s.replace(" Semester", "")} Sem {already ? "✓" : ""}
              </button>
            );
          })}
        </div>

        {IT_ELIGIBLE_LEVELS.has(level) && (
          <div style={{ background:"#f5f3ff", border:"1px solid #ddd6fe", borderLeft:"3px solid #7c3aed", borderRadius:8, padding:"10px 12px", marginBottom:16, fontSize:"0.75rem", color:"#5b21b6", lineHeight:1.55 }}>
            🏭 <strong>IT/SIWES available</strong> — for {level}L semesters you can mark any course as IT and enter its grade + credit units.
          </div>
        )}

        <button style={F.primaryBtn} onClick={handleAdd} disabled={!picked.length}>
          Add {picked.length} Semester{picked.length !== 1 ? "s" : ""} →
        </button>
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════════════════════ */
const Dashboard = ({ regNo, userData, isTrial, onLogout, onPay }) => {
  const [mode,setMode]=useState("real");
  const [semesters,setSemesters]=useState(() => safeParseJson(userData?.semesters_data, {}));
  const lastSyncedReg = useRef(null);
  const [showModal,setShowModal]=useState(false); const [globalSave,setGlobalSave]=useState(false); const [saveErr,setSaveErr]=useState("");
  const [pdfLoading,setPdfLoading]=useState(false);

  useEffect(() => {
    if (!userData||!regNo) return;
    const incomingData = safeParseJson(userData.semesters_data, {});
    const hasData = Object.keys(incomingData).length>0;
    if (lastSyncedReg.current!==regNo||hasData) { lastSyncedReg.current=regNo; setSemesters(incomingData); }
  }, [userData, regNo]);

  const currentList = semesters[mode]||[];
  // Count unique sessions added (not semesters)
const uniqueSessions = [...new Set(currentList.map(s => s.session))];
const trialLimitReached = isTrial && uniqueSessions.length >= 1;
  const savedList = currentList.filter(s=>s.courses?.length>0);
  const cgpa = computeCGPA(savedList); const cl = classify(cgpa);

  const persist = async (updated) => {
    setSemesters(updated); setSaveErr(""); setGlobalSave(true);
    try { await DB.saveSemesters(regNo, updated); }
    catch(e) { setSaveErr("Auto-save failed — check your connection."); }
    finally { setGlobalSave(false); }
  };

  const addSemesters = (toAdd) => persist({ ...semesters, [mode]:[...currentList,...toAdd] });
  const saveSemester = async ({ semKey,level,sem,session,courses,gpa }) => {
    const entry = { semKey,level,sem,session,courses,gpa };
    await persist({ ...semesters, [mode]:[...currentList.filter(s=>s.semKey!==semKey),entry] });
  };
  const deleteSemester = (semKey) => {
    if (!window.confirm("Remove this semester?")) return;
    persist({ ...semesters, [mode]:currentList.filter(s=>s.semKey!==semKey) });
  };

  const handleDownloadPDF = async () => {
    if (!savedList.length || cgpa==null) return;
    setPdfLoading(true);
    try { await generateTranscriptPDF(regNo, savedList, cgpa); }
    catch(e) { alert("PDF generation failed: "+e.message); }
    finally { setPdfLoading(false); }
  };

  const summaryLines = () => {
    if (!cgpa||isTrial) return null;
    const allCourses = savedList.flatMap(s=>s.courses||[]);
    const totalUnits = allCourses.reduce((a,c)=>a+Number(c.points||0)+(c.isIT&&c.itUnits?Number(c.itUnits):0),0);
    const aCount=allCourses.filter(c=>c.grade==="A").length; const fCount=allCourses.filter(c=>c.grade==="F").length;
    const itCourses=allCourses.filter(c=>c.isIT&&c.itGrade&&c.itUnits);
    const lines=[`${savedList.length} semester${savedList.length!==1?"s":""}, ${totalUnits} credit units calculated.`];
    if (itCourses.length) lines.push(`${itCourses.length} IT/SIWES course${itCourses.length>1?"s":""} included in your CGPA calculation.`);
    if (aCount) lines.push(`${aCount} A grade${aCount>1?"s":""} worked in your favour — each A pulls your average up by 5 points per unit.`);
    if (fCount) lines.push(`${fCount} F grade${fCount>1?"s":""} is dragging you down. A retake scoring C or above will help noticeably.`);
    if (cgpa>=4.5) lines.push("You're in First Class territory. Keep this up and it's yours.");
    else if (cgpa>=3.5) lines.push(`First Class needs 4.50 — you're ${fmt(4.5-cgpa)} points away. Achievable with strong upcoming semesters.`);
    else if (cgpa>=2.4) lines.push(`A 2:1 needs 3.50 — you need +${fmt(3.5-cgpa)} average improvement. Focus on eliminating D and E grades.`);
    else lines.push("Focus on retakes for your worst grades first — they give the biggest CGPA boost per effort.");
    return lines;
  };

  const semOrder=(s)=>(parseInt(s.level)||0)*10+(s.sem==="First Semester"?0:1);
  const sorted=[...currentList].sort((a,b)=>semOrder(a)-semOrder(b));

  return (
    <div style={{ width:"100%", maxWidth:700, padding:"16px 0 80px" }} className="dash-wrap">
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20, paddingBottom:16, borderBottom:"2px solid #f1f5f9" }}>
        <div>
          <div style={{ fontFamily:"var(--display)", fontSize:"1.8rem", color:"#0f172a", letterSpacing:"0.03em" }}>CGPACalc</div>
          <div style={{ fontFamily:"var(--mono)", fontSize:"0.65rem", color:"#94a3b8", marginTop:2 }}>{regNo}</div>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {globalSave&&<span style={{ fontSize:"0.7rem", color:"#94a3b8", fontFamily:"var(--mono)" }}>Saving…</span>}
          {saveErr&&<span style={{ fontSize:"0.7rem", color:"#dc2626", fontFamily:"var(--mono)" }}>⚠ {saveErr}</span>}
          <button style={{ background:"none", border:"1px solid #e2e8f0", borderRadius:8, padding:"7px 14px", cursor:"pointer", fontFamily:"var(--mono)", fontSize:"0.7rem", color:"#94a3b8" }} onClick={onLogout}>Log out</button>
        </div>
      </div>

      {/* Trial paywall */}
      {isTrial && (
        <div style={{ background:"linear-gradient(135deg,#fffbeb 0%,#fef3c7 100%)", border:"1.5px solid #fde68a", borderLeft:"4px solid #f59e0b", borderRadius:14, padding:"16px 20px", marginBottom:20, display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12 }}>
          <div>
            <div style={{ fontWeight:800, fontSize:"0.88rem", color:"#92400e", marginBottom:3 }}>🔒 Preview mode — Full CGPA + Transcript PDF locked</div>
            <div style={{ fontSize:"0.75rem", color:"#b45309", lineHeight:1.6 }}>You can enter semesters. Your cumulative CGPA, degree class, and downloadable transcript PDF unlock after a one-time ₦299 payment.</div>
          </div>
          <button style={{ background:"#d97706", color:"#fff", border:"none", borderRadius:9, padding:"10px 20px", fontWeight:800, fontSize:"0.82rem", cursor:"pointer", fontFamily:"var(--body)", whiteSpace:"nowrap", boxShadow:"0 2px 10px rgba(217,119,6,0.3)" }} onClick={onPay}>Unlock for ₦299 →</button>
        </div>
      )}

      {/* CGPA display */}
      {cgpa!=null&&!isTrial&&(
        <div style={D.cgpaBig}>
          <div style={{ fontSize:"0.67rem", color:"#64748b", textTransform:"uppercase", letterSpacing:"0.12em", marginBottom:8 }}>{mode==="expect"?"Projected ":""}CGPA · {savedList.length} semester{savedList.length!==1?"s":""}</div>
          <div style={{ fontFamily:"var(--display)", fontSize:"5rem", color:cl.color, lineHeight:1, marginBottom:4 }} className="cgpa-number">{fmt(cgpa)}</div>
          <div style={{ fontWeight:800, fontSize:"1rem", color:cl.color, marginBottom:12 }}>{cl.label}</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6, justifyContent:"center", marginBottom:16 }}>
            {savedList.sort((a,b)=>semOrder(a)-semOrder(b)).map(s=>{const sc=classify(s.gpa);return(<span key={s.semKey} style={{ background:sc.color+"18", color:sc.color, border:`1px solid ${sc.color}33`, borderRadius:20, padding:"3px 10px", fontSize:"0.68rem", fontFamily:"var(--mono)", fontWeight:700 }}>{s.level}L {s.sem==="First Semester"?"S1":"S2"} · {fmt(s.gpa)}</span>);})}
          </div>
          {/* PDF Download Button */}
          <button
            onClick={handleDownloadPDF}
            disabled={pdfLoading}
            style={{ background:"#0f172a", color:"#fff", border:"none", borderRadius:10, padding:"11px 22px", fontWeight:700, fontSize:"0.82rem", cursor:pdfLoading?"not-allowed":"pointer", fontFamily:"var(--body)", display:"inline-flex", alignItems:"center", gap:8, opacity:pdfLoading?0.6:1, transition:"all 0.2s", boxShadow:"0 2px 12px rgba(0,0,0,0.15)" }}
          >
            <span style={{ fontSize:"1rem" }}>📄</span>
            {pdfLoading ? "Generating PDF…" : "Download Transcript PDF"}
          </button>
        </div>
      )}

      {/* CGPA blurred teaser */}
      {cgpa!=null&&isTrial&&(
        <div style={{ position:"relative", marginBottom:16 }}>
          <div style={{ ...D.cgpaBig, filter:"blur(7px)", userSelect:"none", pointerEvents:"none", marginBottom:0 }}>
            <div style={{ fontSize:"0.67rem", color:"#64748b", textTransform:"uppercase", letterSpacing:"0.12em", marginBottom:8 }}>CGPA · {savedList.length} semester{savedList.length!==1?"s":""}</div>
            <div style={{ fontFamily:"var(--display)", fontSize:"5rem", color:"#059669", lineHeight:1, marginBottom:4 }}>{fmt(cgpa)}</div>
            <div style={{ fontWeight:800, fontSize:"1rem", color:"#059669", marginBottom:12 }}>First Class Honours</div>
          </div>
          <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:10 }}>
            <div style={{ fontSize:"1.5rem" }}>🔒</div>
            <div style={{ fontWeight:800, fontSize:"0.9rem", color:"#0f172a", textAlign:"center" }}>Your CGPA is calculated</div>
            <div style={{ fontSize:"0.75rem", color:"#64748b", textAlign:"center", maxWidth:220, lineHeight:1.6 }}>Unlock for ₦299 to see your result, degree class, and download your transcript PDF</div>
            <button style={{ background:"#059669", color:"#fff", border:"none", borderRadius:9, padding:"9px 20px", fontWeight:800, fontSize:"0.82rem", cursor:"pointer", fontFamily:"var(--body)", marginTop:4, boxShadow:"0 2px 12px rgba(5,150,105,0.3)" }} onClick={onPay}>Unlock for ₦299 →</button>
          </div>
        </div>
      )}

      {/* Summary */}
      {summaryLines()&&(
        <div style={D.summaryBox}>
          <div style={{ fontSize:"0.62rem", color:"#94a3b8", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:10, fontWeight:700 }}>What this means</div>
          {summaryLines().map((l,i)=>(<div key={i} style={{ fontSize:"0.84rem", color:"#374151", lineHeight:1.75, paddingBottom:8, marginBottom:8, borderBottom:i<summaryLines().length-1?"1px solid #f8fafc":"none" }}>{l}</div>))}
        </div>
      )}

      {/* Mode tabs */}
      {!isTrial&&(
        <div style={{ display:"flex", gap:6, background:"#f8fafc", borderRadius:12, padding:4, marginBottom:16 }}>
          {[["real","📊 Real Results"],["expect","🧪 Expectancy Simulator"]].map(([m,label])=>(
            <button key={m} style={{ flex:1, padding:"10px", borderRadius:8, border:"none", cursor:"pointer", fontFamily:"var(--mono)", fontSize:"0.78rem", transition:"all 0.2s", background:mode===m?"#0f172a":"none", color:mode===m?"#fff":"#94a3b8", fontWeight:mode===m?700:400 }} onClick={()=>setMode(m)}>{label}</button>
          ))}
        </div>
      )}

      {mode==="expect"&&!isTrial&&(<div style={{ background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:10, padding:"10px 14px", fontSize:"0.78rem", color:"#1d4ed8", marginBottom:14 }}>🧪 Simulator — projected grades only. Completely separate from your real data.</div>)}

      {/* Semester list */}
      {currentList.length===0?(
        <div style={D.emptyState}>
          <div style={{ fontSize:"3rem", marginBottom:12 }}>📚</div>
          <div style={{ fontWeight:700, fontSize:"1rem", color:"#374151", marginBottom:6 }}>No semesters yet</div>
          <div style={{ fontSize:"0.84rem", color:"#94a3b8", marginBottom:20 }}>Add a session to get started. Add whichever semesters you have results for — in any order.</div>
          <button style={{ ...F.primaryBtn, width:"auto", padding:"12px 24px", display:"inline-block", opacity: trialLimitReached ? 0.5 : 1, cursor: trialLimitReached ? "not-allowed" : "pointer" }} onClick={()=>{ if(!trialLimitReached) setShowModal(true); }}>+ Add Session →</button>
        </div>
      ):(
        <>
          {sorted.map(s=>(<SemesterForm key={s.semKey} semKey={s.semKey} level={s.level} sem={s.sem} session={s.session} initCourses={s.courses||[]} collapsed={s.courses?.length>0} onSave={saveSemester} onDelete={deleteSemester} />))}
          <div style={{ display:"flex", gap:10, marginTop:16 }}>
           {trialLimitReached ? (
  <div style={{ ...DS.addMoreBtn, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:4, cursor:"not-allowed", opacity:1, background:"#fffbeb", border:"1.5px dashed #fde68a" }} onClick={onPay}>
    <span style={{ fontSize:"0.85rem", fontWeight:800, color:"#92400e" }}>🔒 Unlock to add more sessions</span>
    <span style={{ fontSize:"0.72rem", color:"#b45309" }}>Pay ₦299 for full access → all levels, all semesters</span>
  </div>
) : (
  <button style={DS.addMoreBtn} onClick={()=>setShowModal(true)}>+ Add Session</button>
)}
          </div>
        </>
      )}

      {/* Grading scale */}
      {cgpa!=null&&!isTrial&&(
        <div style={D.scaleBox}>
          <div style={{ fontSize:"0.62rem", color:"#94a3b8", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:10, fontWeight:700 }}>Nigerian 5-Point Scale</div>
          {[["A","70–100","5.0","#059669"],["B","60–69","4.0","#0284c7"],["C","50–59","3.0","#7c3aed"],["D","45–49","2.0","#d97706"],["E","40–44","1.0","#ea580c"],["F","0–39","0.0","#dc2626"]].map(([g,r,p,col])=>(
            <div key={g} style={{ display:"flex", alignItems:"center", gap:10, padding:"5px 0", borderBottom:"1px solid #f8fafc" }}>
              <span style={{ fontFamily:"var(--mono)", fontWeight:800, color:col, width:20 }}>{g}</span>
              <span style={{ fontFamily:"var(--mono)", fontSize:"0.74rem", color:"#64748b", width:70 }}>{r}</span>
              <span style={{ fontFamily:"var(--mono)", fontWeight:700, color:col, width:30 }}>{p}</span>
              <div style={{ flex:1, height:4, borderRadius:2, background:"#f1f5f9" }}><div style={{ height:"100%", width:`${(parseFloat(p)/5)*100}%`, background:col, borderRadius:2 }} /></div>
            </div>
          ))}
        </div>
      )}

      {showModal&&(<AddSessionModal existing={currentList} onAdd={addSemesters} onClose={()=>setShowModal(false)} regNo={regNo} />)}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════
   ATOMS
═══════════════════════════════════════════════════════════ */
const Field = ({ label, type="text", placeholder, value, onChange, upper }) => (
  <div style={{ marginBottom:16 }}>
    {label&&<label style={F.lbl}>{label}</label>}
    <input style={F.inp} type={type} placeholder={placeholder} value={value} autoCapitalize={upper?"characters":undefined} onChange={e=>onChange(upper?e.target.value.toUpperCase():e.target.value)} />
  </div>
);
const PrimaryBtn = ({ children, onClick, loading, disabled, style={} }) => (
  <button style={{ ...F.primaryBtn, ...style, opacity:loading||disabled?0.55:1, cursor:loading||disabled?"not-allowed":"pointer" }} onClick={onClick} disabled={loading||disabled}>{loading?"Please wait…":children}</button>
);
const Err = ({ msg }) => <div style={F.err}>{msg}</div>;

/* ═══════════════════════════════════════════════════════════
   ADMIN
═══════════════════════════════════════════════════════════ */
const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD || "cgpa_admin_2025";

const AdminLogin = ({ onSuccess }) => {
  const [pw,setPw]=useState(""); const [err,setErr]=useState("");
  const handle = () => { if(pw===ADMIN_PASSWORD){onSuccess();}else{setErr("Wrong password.");setPw("");} };
  return (
    <div style={{ ...F.wrap, marginTop:60 }} className="page-enter">
      <div style={F.chip}>Admin Access</div>
      <h2 style={F.h2}>Admin Panel</h2>
      <p style={F.sub}>Enter your admin password to manage payments.</p>
      <Field label="Admin Password" type="password" placeholder="••••••••" value={pw} onChange={setPw} />
      {err&&<div style={F.err}>{err}</div>}
      <button style={F.primaryBtn} onClick={handle}>Enter →</button>
      <div style={{ marginTop:14, fontSize:"0.72rem", color:"#94a3b8", textAlign:"center" }}>Go to <a href="/" style={{ color:"#059669" }}>homepage</a></div>
    </div>
  );
};

const AdminDashboard = ({ onLogout }) => {
  const [users,setUsers]=useState([]); const [receipts,setReceipts]=useState([]); const [loading,setLoading]=useState(true);
  const [filter,setFilter]=useState("pending"); const [approving,setApproving]=useState(null); const [viewReceipt,setViewReceipt]=useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data:u },{ data:r }]=await Promise.all([
        supabase.from("users").select("*").order("created_at",{ascending:false}),
        supabase.from("receipts").select("*").order("submitted_at",{ascending:false}),
      ]);
      setUsers(u||[]); setReceipts(r||[]);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const approve = async (regNo) => {
    setApproving(regNo);
    try {
      await supabase.from("users").update({ status:"approved", approved_at:new Date().toISOString() }).eq("reg_no",regNo);
      setUsers(p=>p.map(u=>u.reg_no===regNo?{...u,status:"approved"}:u));
    } finally { setApproving(null); }
  };

  const revoke = async (regNo) => {
    if (!window.confirm(`Revoke access for ${regNo}?`)) return;
    await supabase.from("users").update({ status:"pending" }).eq("reg_no",regNo);
    setUsers(p=>p.map(u=>u.reg_no===regNo?{...u,status:"pending"}:u));
  };

  const revoke = async (regNo) => {
  if (!window.confirm(`Revoke access for ${regNo}?`)) return;
  await supabase.from("users").update({ status:"pending" }).eq("reg_no",regNo);
  setUsers(p=>p.map(u=>u.reg_no===regNo?{...u,status:"pending"}:u));
};

const deleteUser = async (regNo) => {
  if (!window.confirm(`Permanently delete ${regNo} and all their data?`)) return;
  await supabase.from("receipts").delete().eq("reg_no", regNo);
  const { data: files } = await supabase.storage.from("receipts").list(regNo);
  if (files?.length) {
    const paths = files.map(f => `${regNo}/${f.name}`);
    await supabase.storage.from("receipts").remove(paths);
  }
  await supabase.from("users").delete().eq("reg_no", regNo);
  setUsers(p => p.filter(u => u.reg_no !== regNo));
};

  const getReceiptUrl = async (path) => {
    const { data } = await supabase.storage.from("receipts").createSignedUrl(path,60);
    if (data?.signedUrl) setViewReceipt(data.signedUrl);
  };

  const filtered=users.filter(u=>filter==="all"?true:u.status===filter);
  const pendingCount=users.filter(u=>u.status==="pending").length;
  const approvedCount=users.filter(u=>u.status==="approved").length;

  return (
    <div style={{ width:"100%", maxWidth:720, padding:"20px 0 80px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24, paddingBottom:16, borderBottom:"2px solid #f1f5f9" }}>
        <div>
          <div style={{ fontFamily:"var(--display)", fontSize:"1.8rem", color:"#0f172a" }}>Admin Panel</div>
          <div style={{ fontSize:"0.72rem", color:"#94a3b8", marginTop:2 }}>CGPACalc · Payment Approvals</div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button style={{ ...F.ghostBtn, padding:"7px 14px", fontSize:"0.75rem" }} onClick={load}>↻ Refresh</button>
          <button style={{ ...F.ghostBtn, padding:"7px 14px", fontSize:"0.75rem", color:"#dc2626", borderColor:"#fecaca" }} onClick={onLogout}>Log out</button>
        </div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:24 }}>
        {[["Total Users",users.length,"#0f172a"],["Pending",pendingCount,"#d97706"],["Approved",approvedCount,"#059669"]].map(([label,count,color])=>(
          <div key={label} style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"16px", textAlign:"center" }}>
            <div style={{ fontFamily:"var(--mono)", fontSize:"2rem", fontWeight:800, color, lineHeight:1 }}>{count}</div>
            <div style={{ fontSize:"0.72rem", color:"#94a3b8", marginTop:4 }}>{label}</div>
          </div>
        ))}
      </div>
      <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:12, padding:"14px 18px", marginBottom:24, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <span style={{ fontSize:"0.82rem", color:"#374151" }}>Estimated revenue</span>
        <span style={{ fontFamily:"var(--mono)", fontWeight:800, color:"#059669", fontSize:"1.1rem" }}>₦{(approvedCount*299).toLocaleString()}</span>
      </div>
      <div style={{ display:"flex", gap:4, background:"#f8fafc", borderRadius:10, padding:4, marginBottom:16 }}>
        {[["pending","⏳ Pending"],["approved","✓ Approved"],["all","All"]].map(([k,label])=>(
          <button key={k} style={{ flex:1, padding:"9px", borderRadius:7, border:"none", cursor:"pointer", fontFamily:"var(--mono)", fontSize:"0.75rem", background:filter===k?"#0f172a":"none", color:filter===k?"#fff":"#64748b", fontWeight:filter===k?700:400 }} onClick={()=>setFilter(k)}>{label} {k!=="all"&&`(${k==="pending"?pendingCount:approvedCount})`}</button>
        ))}
      </div>
      {loading?(<div style={{ textAlign:"center", padding:"40px", color:"#94a3b8" }}>Loading…</div>):filtered.length===0?(<div style={{ textAlign:"center", padding:"40px", color:"#94a3b8", fontSize:"0.88rem" }}>No {filter==="all"?"":filter} users yet.</div>):filtered.map(u=>{
        const userReceipts=receipts.filter(r=>r.reg_no===u.reg_no);
        const isPending=u.status==="pending"; const isApproved=u.status==="approved";
        return (
          <div key={u.reg_no} style={{ background:"#fff", border:`1px solid ${isPending?"#fde68a":isApproved?"#bbf7d0":"#e2e8f0"}`, borderLeft:`4px solid ${isPending?"#f59e0b":isApproved?"#059669":"#e2e8f0"}`, borderRadius:12, padding:"16px", marginBottom:10 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:10 }}>
              <div>
                <div style={{ fontFamily:"var(--mono)", fontWeight:800, fontSize:"0.95rem", color:"#0f172a" }}>{u.reg_no}</div>
                <div style={{ fontSize:"0.7rem", color:"#94a3b8", marginTop:3 }}>Registered: {new Date(u.created_at).toLocaleString("en-NG",{dateStyle:"medium",timeStyle:"short"})}</div>
                {isApproved&&u.approved_at&&(<div style={{ fontSize:"0.7rem", color:"#059669", marginTop:2 }}>Approved: {new Date(u.approved_at).toLocaleString("en-NG",{dateStyle:"medium",timeStyle:"short"})}</div>)}
              </div>
              <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
                <span style={{ background:isPending?"#fffbeb":isApproved?"#f0fdf4":"#f8fafc", color:isPending?"#d97706":isApproved?"#059669":"#64748b", border:`1px solid ${isPending?"#fde68a":isApproved?"#bbf7d0":"#e2e8f0"}`, borderRadius:20, padding:"3px 10px", fontSize:"0.7rem", fontWeight:700 }}>{isPending?"⏳ Pending":isApproved?"✓ Approved":u.status}</span>
                {userReceipts.length>0&&(<button style={{ ...F.ghostBtn, padding:"5px 12px", fontSize:"0.72rem", color:"#0284c7", borderColor:"#bae6fd" }} onClick={()=>getReceiptUrl(userReceipts[0].receipt_url)}>📎 View Receipt</button>)}
                {isPending&&(<button style={{ background:"#059669", color:"#fff", border:"none", borderRadius:8, padding:"7px 16px", fontSize:"0.8rem", fontWeight:800, cursor:"pointer", fontFamily:"var(--body)", opacity:approving===u.reg_no?0.6:1 }} onClick={()=>approve(u.reg_no)} disabled={approving===u.reg_no}>{approving===u.reg_no?"Approving…":"✓ Approve"}</button>)}
                {isApproved&&(<button style={{ ...F.ghostBtn, padding:"5px 12px", fontSize:"0.72rem", color:"#dc2626", borderColor:"#fecaca" }} onClick={()=>revoke(u.reg_no)}>Revoke</button>)}
                <button style={{ ...F.ghostBtn, padding:"5px 12px", fontSize:"0.72rem", color:"#dc2626", borderColor:"#fecaca", background:"#fef2f2" }} onClick={()=>deleteUser(u.reg_no)}>🗑 Delete</button>
              </div>
            </div>
            {userReceipts.length===0&&isPending&&(<div style={{ marginTop:10, fontSize:"0.72rem", color:"#f59e0b", background:"#fffbeb", border:"1px solid #fde68a", borderRadius:6, padding:"5px 10px", display:"inline-block" }}>⚠ No receipt uploaded yet</div>)}
          </div>
        );
      })}
      {viewReceipt&&(
        <div style={DS.modalOverlay} onClick={()=>setViewReceipt(null)}>
          <div style={{ background:"#fff", borderRadius:16, padding:16, maxWidth:440, width:"100%" }} onClick={e=>e.stopPropagation()}>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:12 }}>
              <span style={{ fontWeight:700, color:"#0f172a" }}>Payment Receipt</span>
              <button style={DS.xBtn} onClick={()=>setViewReceipt(null)}>×</button>
            </div>
            <img src={viewReceipt} alt="receipt" style={{ width:"100%", borderRadius:10, maxHeight:500, objectFit:"contain" }} />
          </div>
        </div>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════
   ROOT APP
═══════════════════════════════════════════════════════════ */
const useScreenHistory = (screen, setScreen) => {
  useEffect(() => { if (!window.history.state?.screen) window.history.replaceState({ screen }, ""); }, []);
  const fromPopRef = useRef(false);
  useEffect(() => {
    if (fromPopRef.current) { fromPopRef.current=false; return; }
    if (screen==="loading") { window.history.replaceState({ screen }, ""); return; }
    window.history.pushState({ screen }, "");
  }, [screen]);
  useEffect(() => {
    const onPop = (e) => {
      const target=e.state?.screen; if(!target) return;
      const session=sessionStorage.getItem("cgpa_sess");
      if ((target==="dash"||target==="payment")&&!session) { fromPopRef.current=true; setScreen("landing"); window.history.replaceState({ screen:"landing" }, ""); return; }
      fromPopRef.current=true; setScreen(target);
    };
    window.addEventListener("popstate",onPop); return () => window.removeEventListener("popstate",onPop);
  }, [setScreen]);
};

export default function App() {
  const cd = useCountdown();
  const [screen,setScreen]=useState("loading"); const [regNo,setRegNo]=useState(""); const [userData,setUserData]=useState(null);
  const [isTrial,setIsTrial]=useState(false); const [adminAuthed,setAdminAuthed]=useState(false);
  const isAdminRoute = window.location.hash==="#admin";

  useScreenHistory(screen, setScreen);

  useEffect(() => {
    const restore = async () => {
      const raw=sessionStorage.getItem("cgpa_sess");
      if (!raw) { setScreen("landing"); return; }
      let parsed; try { parsed=JSON.parse(raw); } catch { sessionStorage.removeItem("cgpa_sess"); setScreen("landing"); return; }
      const { r }=parsed; if (!r) { sessionStorage.removeItem("cgpa_sess"); setScreen("landing"); return; }
      try {
        const freshUser=await DB.getUser(r);
        if (!freshUser) { sessionStorage.removeItem("cgpa_sess"); setScreen("landing"); return; }
        setRegNo(r); setUserData(freshUser);
        const isApproved=freshUser.status==="approved";
        setIsTrial(!isApproved); setScreen("dash");
        sessionStorage.setItem("cgpa_sess",JSON.stringify({ r, trial:!isApproved }));
      } catch(err) { sessionStorage.removeItem("cgpa_sess"); setScreen("landing"); }
    };
    restore();
  }, []);

  const afterApproved=(r,u)=>{ setRegNo(r);setUserData(u);setIsTrial(false);setScreen("dash");sessionStorage.setItem("cgpa_sess",JSON.stringify({r,trial:false})); };
  const afterPending=(r,u)=>{ setRegNo(r);setUserData(u);setScreen("pending-approval"); };
  const afterTrial=(r,u)=>{ setRegNo(r);setUserData(u);setIsTrial(true);setScreen("dash");sessionStorage.setItem("cgpa_sess",JSON.stringify({r,trial:true})); };
  const afterRegister=(r,u)=>{ setRegNo(r);setUserData(u);setIsTrial(true);setScreen("dash");sessionStorage.setItem("cgpa_sess",JSON.stringify({r,trial:true})); };
  const logout=()=>{ sessionStorage.removeItem("cgpa_sess");setRegNo("");setUserData(null);setIsTrial(false);setScreen("landing"); };
  const goToPayment=()=>setScreen("payment");

  if (screen==="loading") return (
    <>
      <style>{globalStyles}</style>
      <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"var(--bg)", flexDirection:"column", gap:14 }}>
        <div style={{ fontFamily:"var(--display)", fontSize:"2rem", color:"#0f172a", letterSpacing:"0.03em" }}>CGPACalc</div>
        <div style={{ fontFamily:"var(--mono)", fontSize:"0.72rem", color:"#94a3b8", animation:"pulse 1.5s infinite" }}>Loading your data…</div>
      </div>
    </>
  );

  return (
    <>
      <style>{globalStyles}</style>
      <div className="orb1" aria-hidden /><div className="orb2" aria-hidden /><div className="orb3" aria-hidden />
      <div style={{ minHeight:"100vh", background:"var(--bg)", display:"flex", flexDirection:"column", alignItems:"center", padding:"0 20px" }}>
        {screen!=="dash"&&(
          <nav style={{ width:"100%", maxWidth:700, display:"flex", justifyContent:"space-between", alignItems:"center", padding:"18px 0", borderBottom:"1px solid #f1f5f9", marginBottom:8 }} className="nav-bar">
            <span style={{ fontFamily:"var(--display)", fontSize:"1.6rem", fontWeight:700, color:"#0f172a", cursor:"pointer", letterSpacing:"0.02em" }} onClick={()=>setScreen("landing")}>CGPACalc</span>
            {screen==="landing"&&(
              <div style={{ display:"flex", gap:10 }}>
                <button style={{ ...F.ghostBtn, width:"auto", marginBottom:0, padding:"9px 18px" }} onClick={()=>setScreen("login")}>Log in</button>
                <button style={{ ...F.primaryBtn, width:"auto", padding:"9px 18px" }} onClick={()=>setScreen("register")}>Get started →</button>
              </div>
            )}
          </nav>
        )}
        {isAdminRoute?(adminAuthed?<AdminDashboard onLogout={()=>setAdminAuthed(false)}/>:<AdminLogin onSuccess={()=>setAdminAuthed(true)}/>):(
          <>
            {screen==="landing"&&<Landing cd={cd} onRegister={()=>setScreen("register")} onLogin={()=>setScreen("login")} />}
            {screen==="register"&&<Register onBack={()=>setScreen("landing")} onSuccess={afterRegister} />}
            {screen==="login"&&<Login onBack={()=>setScreen("landing")} onApproved={afterApproved} onPending={afterPending} onTrial={afterTrial} />}
            {screen==="pending-approval"&&<PendingApproval regNo={regNo} onBack={()=>setScreen("login")} />}
            {screen==="payment"&&<div style={{ width:"100%", maxWidth:700, marginTop:20 }}><Payment regNo={regNo} cd={cd} onBack={returnFromPayment} onSuccess={async () => { const freshUser = await DB.getUser(regNo); setUserData(freshUser); setIsTrial(false); sessionStorage.setItem("cgpa_sess", JSON.stringify({r:regNo, trial:false})); setScreen("dash"); }} /></div>}
            {screen==="dash"&&userData&&<Dashboard regNo={regNo} userData={userData} isTrial={isTrial} onLogout={logout} onPay={goToPayment} />}
          </>
        )}
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   GLOBAL STYLES
═══════════════════════════════════════════════════════════ */
const globalStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400;1,600&family=Space+Mono:wght@400;700&family=Epilogue:wght@400;500;600;700;800;900&display=swap');

  :root {
    --display: 'Cormorant Garamond', serif;
    --mono:    'Space Mono', monospace;
    --body:    'Epilogue', sans-serif;
    --green:   #059669;
    --navy:    #0f172a;
    --bg:      #fafaf9;
    --safe-b:  env(safe-area-inset-bottom, 0px);
    --safe-t:  env(safe-area-inset-top, 0px);
  }

  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  html { scroll-behavior:smooth; }
  body { background:var(--bg); color:var(--navy); font-family:var(--body); -webkit-font-smoothing:antialiased; overflow-x:hidden; padding-top:var(--safe-t); }
  input, select, button, textarea { font-family:var(--body); }
  input, select, textarea { font-size:16px !important; }
  input:focus, select:focus { outline:none; border-color:var(--green) !important; box-shadow:0 0 0 3px rgba(5,150,105,0.12) !important; }
  input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
  input[type=number] { -moz-appearance:textfield; }
  details summary { cursor:pointer; list-style:none; }
  details summary::-webkit-details-marker { display:none; }

  @keyframes fadeUp   { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
  @keyframes fadeIn   { from{opacity:0} to{opacity:1} }
  @keyframes pulse    { 0%,100%{opacity:1} 50%{opacity:0.5} }
  @keyframes pulseDot { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.4);opacity:0.7} }
  @keyframes float    { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-8px)} }
  @keyframes floatR   { 0%,100%{transform:translateY(0) rotate(0deg)} 50%{transform:translateY(-12px) rotate(3deg)} }
  @keyframes itSlideIn { from{opacity:0;transform:translateY(-6px);max-height:0} to{opacity:1;transform:translateY(0);max-height:400px} }
  @keyframes shimmer  { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
  @keyframes ctaPulse { 0%,100%{box-shadow:0 4px 20px rgba(5,150,105,0.3)} 50%{box-shadow:0 4px 32px rgba(5,150,105,0.55)} }

  .page-enter  { animation:fadeUp 0.4s ease both; }
  .it-panel-enter { animation:itSlideIn 0.22s ease both; }

  /* Nav */
  .nav-bar { animation:fadeIn 0.5s ease both; }

  /* Urgency bar */
  .urg-bar { animation:fadeIn 0.3s ease both; }
  .urg-dot { animation:pulseDot 2s ease-in-out infinite; }

  /* Hero */
  .hero-pill { animation:fadeUp 0.5s 0.1s ease both; }
  .hero-h    { animation:fadeUp 0.6s 0.15s ease both; }

  /* CTA button */
  .cta-btn-hero {
    animation:ctaPulse 2.5s ease-in-out infinite;
    transition:transform 0.15s, box-shadow 0.15s !important;
  }
  .cta-btn-hero:hover { transform:translateY(-2px) !important; }
  .cta-btn-hero:active { transform:translateY(0) !important; }

  /* Pain cards */
  .pain-card { transition:transform 0.15s, box-shadow 0.15s; }
  .pain-card:hover { transform:translateX(4px); box-shadow:0 4px 16px rgba(0,0,0,0.07); }

  /* Feature cards */
  .feat-card { transition:transform 0.18s, box-shadow 0.18s; }
  .feat-card:hover { transform:translateY(-3px); box-shadow:0 6px 20px rgba(0,0,0,0.08); }

  /* Proof cards */
  .proof-card { transition:transform 0.18s, box-shadow 0.18s; }
  .proof-card:hover { transform:translateY(-2px); box-shadow:0 6px 24px rgba(0,0,0,0.09); }

  /* PDF highlight pulse */
  .pdf-highlight { animation:ctaPulse 3s ease-in-out infinite; }

  /* Stat cards */
  .stat-card { animation:fadeUp 0.6s 0.3s ease both; }

  /* Orbs */
  .orb1 { position:fixed; width:600px; height:600px; border-radius:50%; background:radial-gradient(circle,rgba(5,150,105,0.09) 0%,transparent 70%); top:-150px; right:-150px; pointer-events:none; animation:float 10s ease-in-out infinite; }
  .orb2 { position:fixed; width:500px; height:500px; border-radius:50%; background:radial-gradient(circle,rgba(99,102,241,0.07) 0%,transparent 70%); bottom:-80px; left:-100px; pointer-events:none; animation:float 13s ease-in-out infinite reverse; }
  .orb3 { position:fixed; width:300px; height:300px; border-radius:50%; background:radial-gradient(circle,rgba(249,115,22,0.05) 0%,transparent 70%); top:40%; left:50%; pointer-events:none; animation:floatR 18s ease-in-out infinite; }

  ::-webkit-scrollbar { width:5px; }
  ::-webkit-scrollbar-track { background:#fafaf9; }
  ::-webkit-scrollbar-thumb { background:#e2e8f0; border-radius:3px; }

  @media (max-width: 600px) {
    button, [role="button"], summary { min-height:44px; }
    .grade-btn { width:36px !important; height:36px !important; font-size:0.82rem !important; }
    .pt-btn    { width:28px !important; height:36px !important; font-size:0.78rem !important; }
    .it-btn    { width:44px !important; height:36px !important; }
    .course-row-wrap { flex-wrap:wrap; gap:8px !important; padding:8px 0 !important; border-bottom:1px solid #f1f5f9; }
    .grade-group { order:2; width:100%; justify-content:flex-start !important; }
    .unit-group  { order:3; width:100%; justify-content:flex-start !important; }
    .sn-input { order:1; }
    .it-btn   { order:4; margin-left:auto; }
    .x-btn    { order:5; }
    .it-grade-btn { width:46px !important; height:46px !important; font-size:0.92rem !important; }
    .it-quick-chips button { min-height:40px !important; padding:8px 14px !important; }
    .modal-sheet { border-radius:20px 20px 0 0 !important; position:fixed !important; bottom:0 !important; left:0 !important; right:0 !important; max-width:100% !important; max-height:92vh !important; overflow-y:auto !important; -webkit-overflow-scrolling:touch; padding-bottom:calc(24px + var(--safe-b)) !important; }
    .modal-overlay-mobile { align-items:flex-end !important; }
    .dash-wrap  { padding:12px 0 calc(60px + var(--safe-b)) !important; }
    .cgpa-number { font-size:3.8rem !important; }
    .nav-bar   { padding:14px 0 !important; }
    .form-card { padding:24px 18px !important; }
    .trust-row { flex-direction:column !important; gap:4px !important; align-items:center; }
    .trust-row span:nth-child(even) { display:none; }
    .feat-grid { grid-template-columns:1fr !important; }
    .hero-h { font-size:clamp(2.2rem,10vw,3.5rem) !important; }
    .cta-box { padding:24px 16px !important; }
    .stat-card { width:100%; }
  }
  @media (max-width:380px) {
    .grade-btn { width:32px !important; height:34px !important; font-size:0.75rem !important; }
    .pt-btn { width:24px !important; }
    .it-grade-row { gap:5px !important; }
    .it-grade-btn { width:40px !important; height:42px !important; }
  }
`;

/* ═══════════════════════════════════════════════════════════
   STYLE TOKENS
═══════════════════════════════════════════════════════════ */
const DS = {
  semBlock:    { background:"#fff", border:"1px solid #e2e8f0", borderRadius:14, marginBottom:10, overflow:"hidden", transition:"box-shadow 0.15s" },
  semHeader:   { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"14px 16px", cursor:"pointer", userSelect:"none", background:"#fafaf9", minHeight:52 },
  semToggle:   { fontSize:"0.65rem", color:"#94a3b8", width:14, flexShrink:0 },
  semBody:     { padding:"14px 16px", borderTop:"1px solid #f1f5f9" },
  gpaBadge:    { borderRadius:20, padding:"3px 10px", fontSize:"0.68rem", fontFamily:"var(--mono)", fontWeight:700 },
  savedDot:    { fontSize:"0.75rem", color:"#059669", fontWeight:800 },
  deleteBtn:   { background:"none", border:"none", color:"#cbd5e1", cursor:"pointer", fontSize:"1.2rem", padding:"0 6px", lineHeight:1, borderRadius:4, minWidth:36, minHeight:36, display:"flex", alignItems:"center", justifyContent:"center" },
  colHead:     { display:"flex", gap:6, alignItems:"center", color:"#94a3b8", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:8, paddingBottom:8, borderBottom:"2px solid #f1f5f9", fontSize:"0.6rem" },
  courseRow:   { display:"flex", gap:6, alignItems:"center", marginBottom:7, padding:"2px 0" },
  gradeBtn:    { width:30, height:30, borderRadius:6, cursor:"pointer", fontFamily:"var(--mono)", fontSize:"0.78rem", display:"flex", alignItems:"center", justifyContent:"center", transition:"all 0.1s", padding:0, flexShrink:0, border:"2px solid transparent", touchAction:"manipulation" },
  ptBtn:       { width:22, height:30, borderRadius:5, cursor:"pointer", fontFamily:"var(--mono)", fontSize:"0.72rem", display:"flex", alignItems:"center", justifyContent:"center", transition:"all 0.1s", padding:0, flexShrink:0, touchAction:"manipulation" },
  itBtn:       { padding:"4px 6px", borderRadius:6, cursor:"pointer", fontFamily:"var(--mono)", fontSize:"0.65rem", fontWeight:700, border:"none", transition:"all 0.15s", width:38, flexShrink:0, minHeight:30, touchAction:"manipulation" },
  xBtn:        { width:28, height:28, background:"none", border:"none", color:"#cbd5e1", cursor:"pointer", fontSize:"1.1rem", padding:0, flexShrink:0, borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center" },
  addRowBtn:   { width:"100%", background:"none", border:"1.5px dashed #e2e8f0", borderRadius:8, padding:"10px", fontSize:"0.85rem", color:"#94a3b8", cursor:"pointer", fontFamily:"var(--body)", marginTop:4, marginBottom:14, minHeight:44 },
  liveGPA:     { background:"linear-gradient(135deg,#f0fdf4,#f0f9ff)", border:"1px solid #bbf7d0", borderRadius:10, padding:"12px 14px", display:"flex", alignItems:"center", flexWrap:"wrap", gap:4, marginBottom:14 },
  addMoreBtn:  { flex:1, background:"#f8fafc", border:"1.5px dashed #e2e8f0", borderRadius:10, padding:"14px", fontSize:"0.88rem", color:"#64748b", cursor:"pointer", fontFamily:"var(--body)", fontWeight:600, transition:"all 0.15s", minHeight:48 },
  modalOverlay:{ position:"fixed", inset:0, background:"rgba(15,23,42,0.5)", backdropFilter:"blur(5px)", zIndex:100, display:"flex", alignItems:"center", justifyContent:"center", padding:"20px" },
  modal:       { background:"#fff", borderRadius:20, padding:"28px 24px", width:"100%", maxWidth:440, boxShadow:"0 20px 60px rgba(0,0,0,0.2)", maxHeight:"90vh", overflowY:"auto", WebkitOverflowScrolling:"touch" },
  levelChip:   { padding:"10px 14px", borderRadius:8, cursor:"pointer", fontFamily:"var(--mono)", fontSize:"0.8rem", fontWeight:700, transition:"all 0.12s", minHeight:44, display:"flex", alignItems:"center", justifyContent:"center", touchAction:"manipulation" },
};

const L = {
  urgBar:      { width:"calc(100% + 40px)", margin:"0 -20px", background:"linear-gradient(90deg,#f0fdf4,#ecfdf5,#f0fdf4)", borderBottom:"1px solid #bbf7d0", padding:"10px 20px", display:"flex", alignItems:"center", gap:10, justifyContent:"center" },
  urgDot:      { width:8, height:8, borderRadius:"50%", background:"#059669", flexShrink:0 },
  pill:        { display:"inline-block", background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:20, padding:"5px 14px", fontSize:"0.67rem", color:"#059669", letterSpacing:"0.1em", textTransform:"uppercase", fontWeight:600, marginBottom:20 },
  heroH:       { fontFamily:"var(--display)", fontSize:"clamp(2.8rem,8vw,5.2rem)", fontWeight:700, color:"#0f172a", lineHeight:1.08, marginBottom:20, letterSpacing:"0.01em" },
  heroEm:      { color:"#059669", fontStyle:"italic" },
  heroSub:     { fontSize:"1.05rem", color:"#475569", lineHeight:1.9, maxWidth:540, margin:"0 auto 32px", textAlign:"center" },
  statCard:    { display:"inline-flex", flexDirection:"column", alignItems:"center", gap:8, background:"#fff", border:"1px solid #e2e8f0", borderLeft:"4px solid #059669", borderRadius:12, padding:"16px 20px", boxShadow:"0 2px 12px rgba(0,0,0,0.05)", minWidth:160 },
  statNum:     { fontFamily:"var(--display)", fontSize:"2.4rem", color:"#059669", lineHeight:1, fontWeight:700 },
  statTxt:     { fontSize:"0.78rem", color:"#475569", lineHeight:1.5, textAlign:"center" },
  section:     { margin:"40px 0" },
  secLabel:    { fontSize:"0.62rem", color:"#94a3b8", letterSpacing:"0.18em", textTransform:"uppercase", fontWeight:700, marginBottom:16, display:"block" },
  painCard:    { display:"flex", gap:12, alignItems:"flex-start", background:"#fff", border:"1px solid #f1f5f9", borderRadius:12, padding:"16px 18px", boxShadow:"0 1px 4px rgba(0,0,0,0.04)" },
  painIcon:    { fontSize:"1.3rem", flexShrink:0, marginTop:1 },
  productBox:  { background:"#fff", border:"1px solid #e2e8f0", borderRadius:20, padding:"36px 32px", boxShadow:"0 4px 28px rgba(0,0,0,0.07)" },
  prodName:    { fontFamily:"var(--display)", fontSize:"3.2rem", fontWeight:700, color:"#0f172a", marginBottom:12, lineHeight:1 },
  pdfHighlight:{ background:"linear-gradient(135deg,#f0fdf4 0%,#e0f2fe 100%)", border:"1.5px solid #059669", borderRadius:14, padding:"20px 22px", marginBottom:8, textAlign:"center" },
  featCard:    { background:"#fafaf9", border:"1px solid #f1f5f9", borderRadius:14, padding:"20px 18px" },
  proof:       { background:"#fff", border:"1px solid #e2e8f0", borderRadius:16, padding:"22px", boxShadow:"0 2px 8px rgba(0,0,0,0.04)" },
  proofQ:      { fontFamily:"var(--display)", fontSize:"1.05rem", color:"#1e293b", lineHeight:1.8, fontStyle:"italic", fontWeight:400 },
  ctaBox:      { background:"linear-gradient(135deg,#f0fdf4 0%,#e0f2fe 100%)", border:"1px solid #bbf7d0", borderRadius:24, padding:"40px 32px", textAlign:"center" },
  saveBadge:   { background:"#059669", color:"#fff", borderRadius:20, padding:"5px 12px", fontSize:"0.72rem", fontWeight:800, alignSelf:"flex-end", marginBottom:6 },
  ctaBtn:      { width:"100%", background:"#059669", color:"#fff", border:"none", borderRadius:12, padding:"17px", fontSize:"1.02rem", fontWeight:800, cursor:"pointer", fontFamily:"var(--body)", letterSpacing:"0.01em", marginBottom:12, boxShadow:"0 4px 20px rgba(5,150,105,0.3)" },
  ghostBtn:    { width:"100%", background:"none", border:"1px solid #e2e8f0", borderRadius:12, padding:"13px", fontSize:"0.88rem", color:"#64748b", cursor:"pointer", fontFamily:"var(--body)", marginBottom:10 },
  trustRow:    { display:"flex", gap:8, justifyContent:"center", flexWrap:"wrap", fontSize:"0.67rem", color:"#94a3b8", marginTop:12 },
  faqItem:     { border:"1px solid #f1f5f9", borderRadius:12, padding:"16px 18px", marginBottom:8, background:"#fff", cursor:"pointer", transition:"border-color 0.2s" },
};

const F = {
  wrap:       { width:"100%", maxWidth:580, background:"#fff", border:"1px solid #e2e8f0", borderRadius:20, padding:"32px 28px", boxShadow:"0 4px 24px rgba(0,0,0,0.07)", marginTop:24 },
  back:       { background:"none", border:"none", color:"#94a3b8", cursor:"pointer", fontSize:"0.8rem", padding:0, marginBottom:18, fontFamily:"var(--body)", display:"flex", alignItems:"center", gap:4 },
  chip:       { display:"inline-block", background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:20, padding:"4px 12px", fontSize:"0.65rem", color:"#059669", fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:12 },
  h2:         { fontFamily:"var(--display)", fontSize:"2rem", fontWeight:700, color:"#0f172a", marginBottom:8, lineHeight:1.15 },
  sub:        { fontSize:"0.88rem", color:"#64748b", marginBottom:22, lineHeight:1.75 },
  lbl:        { display:"block", fontSize:"0.67rem", color:"#64748b", fontWeight:700, marginBottom:6, letterSpacing:"0.08em", textTransform:"uppercase" },
  inp:        { width:"100%", border:"1.5px solid #e2e8f0", borderRadius:8, padding:"11px 13px", color:"#0f172a", fontSize:"0.9rem", background:"#fafaf9", transition:"all 0.15s", boxSizing:"border-box" },
  sel:        { width:"100%", border:"1.5px solid #e2e8f0", borderRadius:8, padding:"10px 12px", color:"#0f172a", fontSize:"0.88rem", background:"#fafaf9", cursor:"pointer", boxSizing:"border-box" },
  primaryBtn: { background:"#059669", color:"#fff", border:"none", borderRadius:10, padding:"13px 20px", fontSize:"0.92rem", fontWeight:800, cursor:"pointer", fontFamily:"var(--body)", width:"100%", display:"block", transition:"opacity 0.15s", boxShadow:"0 2px 12px rgba(5,150,105,0.25)" },
  ghostBtn:   { background:"none", border:"1.5px solid #e2e8f0", borderRadius:10, padding:"10px 18px", fontSize:"0.85rem", color:"#64748b", cursor:"pointer", fontFamily:"var(--body)" },
  err:        { background:"#fef2f2", border:"1px solid #fecaca", borderRadius:8, color:"#dc2626", padding:"10px 13px", fontSize:"0.8rem", marginBottom:14, lineHeight:1.5 },
  secLabel:   { display:"block", fontSize:"0.62rem", color:"#94a3b8", letterSpacing:"0.18em", textTransform:"uppercase", fontWeight:700, marginBottom:12 },
};

const PAY = {
  urgBox:    { display:"flex", gap:14, background:"#fffbeb", border:"1px solid #fde68a", borderRadius:12, padding:"14px 16px", marginBottom:20, alignItems:"flex-start" },
  priceRow:  { display:"flex", alignItems:"baseline", justifyContent:"center", gap:14, marginBottom:16 },
  badge:     { background:"#059669", color:"#fff", borderRadius:20, padding:"5px 12px", fontSize:"0.72rem", fontWeight:800, alignSelf:"flex-end", marginBottom:6 },
  bankCard:  { background:"#fafaf9", border:"1.5px solid #e2e8f0", borderRadius:14, padding:"20px", marginBottom:20 },
  bankRow:   { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 },
  bankLbl:   { fontSize:"0.67rem", color:"#94a3b8", fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase" },
  bankVal:   { fontSize:"0.9rem", color:"#0f172a", fontWeight:700 },
  copyBtn:   { background:"#059669", color:"#fff", border:"none", borderRadius:6, padding:"6px 12px", cursor:"pointer", fontSize:"0.72rem", fontFamily:"var(--mono)", fontWeight:700 },
  uploadZone:{ border:"2px dashed #e2e8f0", borderRadius:14, padding:"36px 20px", textAlign:"center", cursor:"pointer", marginBottom:16, background:"#fafaf9", transition:"border-color 0.15s" },
  pendingBox:{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:12, padding:"16px", textAlign:"center", margin:"20px 0" },
  waBtn:     { display:"block", background:"#dcfce7", border:"1px solid #bbf7d0", borderRadius:12, color:"#059669", padding:"14px 20px", textDecoration:"none", textAlign:"center", fontSize:"0.88rem", fontFamily:"var(--body)", fontWeight:800, marginTop:14 },
};

const D = {
  cgpaBig:   { background:"linear-gradient(135deg,#f0fdf4,#f0f9ff)", border:"1px solid #e2e8f0", borderRadius:20, padding:"32px", textAlign:"center", marginBottom:16, boxShadow:"0 2px 16px rgba(0,0,0,0.04)" },
  summaryBox:{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:14, padding:"18px", marginBottom:16 },
  scaleBox:  { background:"#fafaf9", border:"1px solid #f1f5f9", borderRadius:14, padding:"16px", marginTop:20 },
  emptyState:{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:16, padding:"48px 20px", textAlign:"center" },
};
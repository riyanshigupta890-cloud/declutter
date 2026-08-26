import { useState, useRef, useEffect } from "react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

const MAX_FILE_MB = 10;
const MAX_SESSION_MB = 50;
const STAMP_DURATION_MS = 550;
const SWIPE_THRESHOLD_PX = 60;
const STORAGE_KEY = "declutter-session-v1";

const VIBRATE_PATTERNS = {
  keep: 15,
  archive: 15,
  skip: 10,
  delete: [15, 40, 15],
};

function vibrate(action) {
  if (typeof navigator === "undefined" || !navigator.vibrate) return;
  navigator.vibrate(VIBRATE_PATTERNS[action] || 15);
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // An in-flight upload can't be resumed — treat it as a fresh start.
    if (parsed.status === "uploading") return null;
    return parsed;
  } catch {
    return null;
  }
}

const restored = loadSession();

export default function App() {
  const [items, setItems] = useState(restored?.items || []);
  const [index, setIndex] = useState(restored?.index || 0);
  const [status, setStatus] = useState(restored?.status || "idle");
  const [error, setError] = useState(null);
  const [stamp, setStamp] = useState(null); // "keep" | "archive" | "delete" | "skip" | null
  const [dragOver, setDragOver] = useState(false);
  const [viewMode, setViewMode] = useState(restored?.viewMode || "single"); // "single" | "list"
  const [listFilter, setListFilter] = useState("all"); // all | keep | archive | delete | skip | undecided
  const [listSort, setListSort] = useState("filename"); // filename | confidence | category
  const fileInputRef = useRef(null);
  const touchStartRef = useRef(null);

  // Persist progress so a refresh mid-review doesn't lose it.
  // Preview object URLs don't survive a reload, so they're dropped before saving.
  useEffect(() => {
    if (status === "idle" || status === "uploading") {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    const toStore = {
      items: items.map(({ preview, ...rest }) => rest),
      index,
      status,
      viewMode,
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  }, [items, index, status, viewMode]);

  async function handleFiles(fileList) {
    setError(null);
    const files = Array.from(fileList);

    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > MAX_SESSION_MB * 1024 * 1024) {
      setError(`Total upload exceeds ${MAX_SESSION_MB}MB. Try a smaller batch.`);
      return;
    }
    const tooBig = files.find((f) => f.size > MAX_FILE_MB * 1024 * 1024);
    if (tooBig) {
      setError(`"${tooBig.name}" exceeds the ${MAX_FILE_MB}MB per-file limit.`);
      return;
    }

    setStatus("uploading");
    const formData = new FormData();
    files.forEach((f) => formData.append("files", f));

    // Keep local object URLs for preview only — never sent anywhere else.
    const previews = new Map(files.map((f) => [f.name, URL.createObjectURL(f)]));

    try {
      const res = await fetch("/classify", { method: "POST", body: formData });
      if (!res.ok) throw new Error((await res.json()).error || "Upload failed");
      const data = await res.json();
      const withPreviews = data.results.map((r) => ({
        ...r,
        preview: previews.get(r.filename) || null,
        decision: null,
      }));
      setItems(withPreviews);
      setIndex(0);
      setStatus(withPreviews.length ? "reviewing" : "idle");
    } catch (err) {
      setError(String(err.message || err));
      setStatus("idle");
    }
  }

  function decide(action) {
    if (stamp) return; // ignore repeat clicks/swipes mid-animation
    vibrate(action);
    setStamp(action);
    setItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], decision: action };
      return next;
    });
  }

  // Direct decision from list view — no stamp animation, no card advance.
  function setItemDecision(itemIndex, action) {
    vibrate(action);
    setItems((prev) => {
      const next = [...prev];
      next[itemIndex] = {
        ...next[itemIndex],
        decision: next[itemIndex].decision === action ? null : action,
      };
      return next;
    });
  }

  function undoLast() {
    if (index === 0) return;
    setStamp(null);
    setItems((prev) => {
      const next = [...prev];
      next[index - 1] = { ...next[index - 1], decision: null };
      return next;
    });
    setIndex((i) => i - 1);
  }

  // Mark every remaining exact duplicate as deleted in one go, then jump
  // to the next file that still needs a manual decision.
  function bulkDeleteExactDuplicates() {
    setItems((prev) => {
      const next = prev.map((i) =>
        i.duplicateType === "exact" && i.decision === null
          ? { ...i, decision: "delete" }
          : i
      );
      const nextIdx = next.findIndex((i) => i.decision === null);
      if (nextIdx === -1) {
        setStatus("done");
      } else {
        setIndex(nextIdx);
      }
      return next;
    });
  }

  // Advance to the next card once the stamp animation has played.
  useEffect(() => {
    if (!stamp) return;
    const timer = setTimeout(() => {
      setStamp(null);
      if (index + 1 < items.length) {
        setIndex((i) => i + 1);
      } else {
        setStatus("done");
      }
    }, STAMP_DURATION_MS);
    return () => clearTimeout(timer);
  }, [stamp]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts: K = keep, A = archive, D = delete, S = skip
  useEffect(() => {
    function onKeyDown(e) {
      if (status !== "reviewing" || viewMode !== "single") return;
      const key = e.key.toLowerCase();
      if (key === "k") decide("keep");
      if (key === "a") decide("archive");
      if (key === "d") decide("delete");
      if (key === "s") decide("skip");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // Swipe gestures for touch devices: right = keep, left = delete, up = archive
  function onCardTouchStart(e) {
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY };
  }

  function onCardTouchEnd(e) {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start) return;

    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;

    if (Math.abs(dx) > Math.abs(dy)) {
      if (dx > SWIPE_THRESHOLD_PX) decide("keep");
      else if (dx < -SWIPE_THRESHOLD_PX) decide("delete");
    } else if (dy < -SWIPE_THRESHOLD_PX) {
      decide("archive");
    }
  }

  function reset() {
    const hasUnreviewed = items.some((i) => i.decision === null);
    if (status === "reviewing" && hasUnreviewed) {
      const confirmed = window.confirm(
        "You still have unreviewed files. Starting over will discard this session. Continue?"
      );
      if (!confirmed) return;
    }
    sessionStorage.removeItem(STORAGE_KEY);
    setItems([]);
    setIndex(0);
    setStatus("idle");
    setError(null);
    setStamp(null);
    setViewMode("single");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function downloadReport() {
    const doc = new jsPDF();
    const generatedAt = new Date().toLocaleString();

    doc.setFont("courier", "bold");
    doc.setFontSize(18);
    doc.text("Declutter — Sorting Report", 14, 18);

    doc.setFont("courier", "normal");
    doc.setFontSize(10);
    doc.text(`Generated ${generatedAt}`, 14, 25);

    doc.setFontSize(11);
    doc.text(`Reviewed ${summary.total} file(s)`, 14, 35);
    doc.text(
      `Kept: ${summary.keep}   Archived: ${summary.archive}   Deleted: ${summary.delete}   Skipped: ${summary.skip}`,
      14,
      42
    );

    autoTable(doc, {
      startY: 50,
      head: [["Filename", "Category", "Decision", "Confidence"]],
      body: items.map((i) => [
        i.filename,
        i.category || "-",
        (i.decision || "skip").toUpperCase(),
        `${Math.round((i.confidence || 0) * 100)}%`,
      ]),
      styles: { font: "courier", fontSize: 9 },
      headStyles: { fillColor: [28, 27, 25] },
    });

    doc.setFontSize(9);
    doc.text(
      "Nothing was actually deleted from your device — this is the review/decision layer only.",
      14,
      doc.lastAutoTable.finalY + 10,
      { maxWidth: 180 }
    );

    doc.save("declutter-report.pdf");
  }

  const current = items[index];
  const summary = {
    total: items.length,
    delete: items.filter((i) => i.decision === "delete").length,
    archive: items.filter((i) => i.decision === "archive").length,
    keep: items.filter((i) => i.decision === "keep").length,
    skip: items.filter((i) => i.decision === "skip").length,
  };

  const stampLabel = {
    keep: "KEPT",
    archive: "ARCHIVED",
    delete: "DELETED",
    skip: "SKIPPED",
  };

  const exactDuplicateCount = items.filter(
    (i) => i.duplicateType === "exact" && i.decision === null
  ).length;

  // Items for list view — filtered and sorted, original index preserved
  // so decisions map back to the right entry in `items`.
  const listItems = items
    .map((item, i) => ({ ...item, _idx: i }))
    .filter((item) => {
      if (listFilter === "all") return true;
      if (listFilter === "undecided") return item.decision === null;
      return item.decision === listFilter;
    })
    .sort((a, b) => {
      if (listSort === "confidence") return (b.confidence || 0) - (a.confidence || 0);
      if (listSort === "category") return (a.category || "").localeCompare(b.category || "");
      return (a.filename || "").localeCompare(b.filename || "");
    });

  return (
    <div className="page">
      <header className="header">
        <h1 className="title">Declutter</h1>
        <p className="tagline">
          An AI that actually looks at your mess and tells you what to kill.
        </p>
      </header>

      {status === "idle" && (
        <div
          className={`upload-tray${dragOver ? " drag-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
          }}
        >
          <label className="upload-label" htmlFor="file-input">
            Choose files to review
          </label>
          <input
            id="file-input"
            className="upload-input"
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*"
            onChange={(e) => e.target.files.length && handleFiles(e.target.files)}
          />
          <p className="hint">
            Images only in this build · up to {MAX_FILE_MB}MB/file ·{" "}
            {MAX_SESSION_MB}MB per session · nothing is stored on our server
          </p>
          {error && <p className="error-text">{error}</p>}
        </div>
      )}

      {status === "uploading" && (
        <p className="loading">Analyzing your files…</p>
      )}

      {status === "reviewing" && current && (
        <div className="view-toggle">
          <button
            className={`view-toggle-btn${viewMode === "single" ? " active" : ""}`}
            onClick={() => setViewMode("single")}
          >
            Card view
          </button>
          <button
            className={`view-toggle-btn${viewMode === "list" ? " active" : ""}`}
            onClick={() => setViewMode("list")}
          >
            List view
          </button>
        </div>
      )}

      {status === "reviewing" && current && viewMode === "single" && (
        <div
          className={`card${stamp ? " stamping" : ""}`}
          onTouchStart={onCardTouchStart}
          onTouchEnd={onCardTouchEnd}
        >
          {stamp && (
            <div className={`stamp stamp-${stamp}`}>{stampLabel[stamp]}</div>
          )}

          <p className="progress">
            {index + 1} / {items.length}
          </p>
          <div className="review-progress-bar">
            <div
              className="review-progress-fill"
              style={{ width: `${Math.round(((index + 1) / items.length) * 100)}%` }}
            />
          </div>

          {exactDuplicateCount > 0 && (
            <div className="bulk-bar">
              <span>
                {exactDuplicateCount} exact duplicate
                {exactDuplicateCount > 1 ? "s" : ""} still ahead
              </span>
              <button className="bulk-bar-btn" onClick={bulkDeleteExactDuplicates}>
                Auto-delete all
              </button>
            </div>
          )}

          {current.preview ? (
            <div className="preview-wrap">
              <img
                src={current.preview}
                alt={current.filename}
                className="preview-img"
              />
            </div>
          ) : (
            <p className="hint" style={{ marginBottom: "0.75rem" }}>
              Preview unavailable after reload — your decision still applies to
              this file.
            </p>
          )}

          <p className="filename">{current.filename}</p>
          <p className="category">{current.category}</p>

          {current.duplicateType === "exact" && (
            <span className="badge badge-exact">Exact duplicate</span>
          )}
          {current.duplicateType === "near" && (
            <span className="badge badge-near">
              Similar to {current.similarTo?.length || 0} other file(s)
            </span>
          )}

          <p className="reasoning">{current.reasoning}</p>

          <p className="confidence">
            confidence {Math.round((current.confidence || 0) * 100)}%
          </p>
          <div className="confidence-bar">
            <div
              className="confidence-fill"
              style={{ width: `${Math.round((current.confidence || 0) * 100)}%` }}
            />
          </div>

          <div className="button-row">
            <button className="decision-btn btn-keep" onClick={() => decide("keep")}>
              Keep <span style={{ opacity: 0.6 }}>(K)</span>
            </button>
            <button className="decision-btn btn-archive" onClick={() => decide("archive")}>
              Archive <span style={{ opacity: 0.6 }}>(A)</span>
            </button>
            <button className="decision-btn btn-delete" onClick={() => decide("delete")}>
              Delete <span style={{ opacity: 0.6 }}>(D)</span>
            </button>
          </div>

          <button className="skip-btn" onClick={() => decide("skip")}>
            Skip for now <span style={{ opacity: 0.6 }}>(S)</span>
          </button>

          <p className="swipe-hint">← delete · archive ↑ · keep →</p>

          {index > 0 && (
            <button className="undo-btn" onClick={undoLast}>
              ← undo last decision
            </button>
          )}
        </div>
      )}

      {status === "reviewing" && viewMode === "list" && (
        <div className="card list-card">
          <div className="list-controls">
            <select
              className="list-select"
              value={listFilter}
              onChange={(e) => setListFilter(e.target.value)}
            >
              <option value="all">All ({items.length})</option>
              <option value="undecided">Undecided</option>
              <option value="keep">Kept</option>
              <option value="archive">Archived</option>
              <option value="delete">Deleted</option>
              <option value="skip">Skipped</option>
            </select>
            <select
              className="list-select"
              value={listSort}
              onChange={(e) => setListSort(e.target.value)}
            >
              <option value="filename">Sort: filename</option>
              <option value="confidence">Sort: confidence</option>
              <option value="category">Sort: category</option>
            </select>
          </div>

          {exactDuplicateCount > 0 && (
            <div className="bulk-bar">
              <span>
                {exactDuplicateCount} exact duplicate
                {exactDuplicateCount > 1 ? "s" : ""} in this batch
              </span>
              <button className="bulk-bar-btn" onClick={bulkDeleteExactDuplicates}>
                Auto-delete all
              </button>
            </div>
          )}

          {listItems.length === 0 && (
            <p className="hint">No files match this filter.</p>
          )}

          <div className="list-rows">
            {listItems.map((item) => (
              <div className="list-row" key={item._idx}>
                <button
                  className="list-row-thumb-btn"
                  onClick={() => {
                    setIndex(item._idx);
                    setViewMode("single");
                  }}
                  title="Open in card view"
                >
                  {item.preview ? (
                    <img
                      src={item.preview}
                      alt={item.filename}
                      className="list-row-thumb"
                    />
                  ) : (
                    <span className="list-row-thumb list-row-thumb-empty" />
                  )}
                </button>
                <div className="list-row-info">
                  <p className="list-row-filename">{item.filename}</p>
                  <p className="list-row-meta">
                    {item.category || "—"} · {Math.round((item.confidence || 0) * 100)}%
                    {item.duplicateType === "exact" && " · exact dup"}
                    {item.duplicateType === "near" && " · near dup"}
                  </p>
                </div>
                <div className="list-row-actions">
                  <button
                    className={`list-action-btn action-keep${item.decision === "keep" ? " active" : ""}`}
                    onClick={() => setItemDecision(item._idx, "keep")}
                  >
                    K
                  </button>
                  <button
                    className={`list-action-btn action-archive${item.decision === "archive" ? " active" : ""}`}
                    onClick={() => setItemDecision(item._idx, "archive")}
                  >
                    A
                  </button>
                  <button
                    className={`list-action-btn action-delete${item.decision === "delete" ? " active" : ""}`}
                    onClick={() => setItemDecision(item._idx, "delete")}
                  >
                    D
                  </button>
                  <button
                    className={`list-action-btn action-skip${item.decision === "skip" ? " active" : ""}`}
                    onClick={() => setItemDecision(item._idx, "skip")}
                  >
                    S
                  </button>
                </div>
              </div>
            ))}
          </div>

          <button className="reset-btn list-finish-btn" onClick={() => setStatus("done")}>
            Finish → view report
          </button>
        </div>
      )}

      {status === "done" && (
        <div className="card">
          <h2 className="summary-title">Sorting report</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Reviewed {summary.total} file(s)
          </p>
          <ul className="summary-list">
            <li>{summary.keep} kept</li>
            <li>{summary.archive} archived</li>
            <li>{summary.delete} marked for delete</li>
            <li>{summary.skip} skipped</li>
          </ul>
          <p className="hint">
            Nothing was actually deleted from your device in this demo — this
            is the review/decision layer only.
          </p>
          <div className="summary-actions">
            <button className="reset-btn" onClick={reset}>
              Start over
            </button>
            <button className="download-btn" onClick={downloadReport}>
              Download report (PDF)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

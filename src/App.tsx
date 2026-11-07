import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { enable } from "@tauri-apps/plugin-autostart";
import logo from "./assets/matping.png";
import "./App.css";

type Target = { id: string; name: string; host: string };
type Line = { text: string; cls: "" | "fail" | "spike" };
type Live = { lines: Line[]; bars: Line["cls"][]; times: number[]; ok?: boolean; ms?: number };
type PingLine = { id: string; line: string; ok: boolean | null; ms: number | null };

const average = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// Spike: more than double the recent average and at least 10 ms above it (needs a few samples first).
const isSpike = (ms: number, times: number[]) => {
  if (times.length < 5) return false;
  const avg = average(times);
  return ms > avg * 2 && ms - avg >= 10;
};

const loadTargets = (): Target[] => {
  try {
    return JSON.parse(localStorage.getItem("targets") ?? "[]");
  } catch {
    return [];
  }
};

export default function App() {
  const [targets, setTargets] = useState(loadTargets);
  const [live, setLive] = useState<Record<string, Live>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState<Target | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const start = (t: Target) =>
    invoke("start_ping", { id: t.id, host: t.host }).catch((e) =>
      setLive((all) => ({
        ...all,
        [t.id]: { lines: [{ text: String(e), cls: "fail" }], bars: ["fail"], times: [], ok: false },
      })),
    );

  useEffect(() => {
    localStorage.setItem("targets", JSON.stringify(targets));
  }, [targets]);

  useEffect(() => {
    let queue: PingLine[] = [];
    const unlisten = listen<PingLine>("ping", ({ payload }) => {
      queue.push(payload);
    });
    // Redraw once a second for all cards together, not once per reply per card.
    const timer = setInterval(() => {
      if (!queue.length) return;
      const batch = queue;
      queue = [];
      setLive((prev) => {
        const all = { ...prev };
        for (const p of batch) {
          const cur = all[p.id] ?? { lines: [], bars: [], times: [] };
          const header = p.ok === null;
          const cls: Line["cls"] = p.ok === false ? "fail" : p.ms != null && isSpike(p.ms, cur.times) ? "spike" : "";
          all[p.id] = {
            lines: [...cur.lines, { text: p.line, cls }].slice(-30),
            bars: header ? cur.bars : [...cur.bars, cls].slice(-60),
            times: p.ms == null ? cur.times : [...cur.times, p.ms].slice(-60),
            ok: header ? cur.ok : p.ok!,
            ms: header ? cur.ms : (p.ms ?? undefined),
          };
        }
        return all;
      });
    }, 1000);
    loadTargets().forEach(start);
    enable().catch(() => {}); // always start with Windows
    return () => {
      clearInterval(timer);
      unlisten.then((off) => off());
    };
  }, []);

  const save = (t: Target) => {
    const host = t.host.trim();
    const next = { ...t, host, name: t.name.trim() || host };
    setTargets((ts) => (ts.some((x) => x.id === t.id) ? ts.map((x) => (x.id === t.id ? next : x)) : [...ts, next]));
    setLive((all) => ({ ...all, [t.id]: { lines: [], bars: [], times: [] } }));
    start(next);
    setForm(null);
  };

  // Move `from` into `to`'s slot; called while dragging so the cards shift live.
  const move = (from: string, to: string) =>
    setTargets((ts) => {
      const a = [...ts];
      const j = a.findIndex((x) => x.id === to);
      a.splice(j, 0, ...a.splice(a.findIndex((x) => x.id === from), 1));
      return a;
    });

  const remove = (t: Target) => {
    invoke("stop_ping", { id: t.id });
    setTargets((ts) => ts.filter((x) => x.id !== t.id));
    setLive(({ [t.id]: _, ...rest }) => rest);
    setForm(null);
  };

  return (
    <>
      <header>
        <img src={logo} alt="MatPing!" className="logo" />
        <button className="link" onClick={() => invoke("open_github")}>
          GitHub
        </button>
        <button onClick={() => setForm({ id: crypto.randomUUID(), name: "", host: "" })}>+ Add</button>
      </header>

      {form && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            save(form);
          }}
        >
          <input
            placeholder="Name"
            aria-label="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            autoFocus
          />
          <input
            placeholder="IP or host"
            aria-label="IP or host"
            required
            value={form.host}
            onChange={(e) => setForm({ ...form, host: e.target.value })}
          />
          <button type="submit">Save</button>
          {targets.some((x) => x.id === form.id) && (
            <button type="button" className="danger" onClick={() => remove(form)}>
              Delete
            </button>
          )}
          <button type="button" onClick={() => setForm(null)}>
            Cancel
          </button>
        </form>
      )}

      {targets.length === 0 && <p className="empty">No targets yet. Click + Add.</p>}

      <main className="grid">
        {targets.map((t) => {
          const l = live[t.id];
          const isOpen = !!open[t.id];
          const avg = l?.times.length ? Math.round(average(l.times)) : null;
          return (
            <div
              key={t.id}
              className={`card ${l?.ok === false ? "down" : ""} ${dragId === t.id ? "dragging" : ""}`}
              draggable
              onDragStart={() => setDragId(t.id)}
              onDragEnter={() => dragId && dragId !== t.id && move(dragId, t.id)}
              onDragOver={(e) => e.preventDefault()}
              onDragEnd={() => setDragId(null)}
            >
              <div className="row">
                <button
                  className="icon"
                  aria-expanded={isOpen}
                  aria-label={`Raw output for ${t.name}`}
                  onClick={() => setOpen({ ...open, [t.id]: !isOpen })}
                >
                  {isOpen ? "▾" : "▸"}
                </button>
                <span className="name" title={t.name}>
                  {t.name}
                </span>
                <span className="ms">{l?.ok === false ? "down" : l?.ms != null ? `${l.ms} ms` : "…"}</span>
                {avg != null && <span className="avg">avg {avg} ms</span>}
                <div className="bars" aria-hidden>
                  {l?.bars.map((b, i) => <i key={i} className={b} />)}
                </div>
                <button className="icon" aria-label={`Edit ${t.name}`} onClick={() => setForm(t)}>
                  ✎
                </button>
              </div>
              {isOpen && (
                <pre
                  ref={(el) => {
                    if (el) el.scrollTop = el.scrollHeight;
                  }}
                >
                  {l?.lines.map((line, i) => (
                    <div key={i} className={line.cls}>
                      {line.text}
                    </div>
                  ))}
                </pre>
              )}
            </div>
          );
        })}
      </main>
    </>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import type { ChatMessage, Person, Proposal, Relationship } from "@/lib/types";
import {
  getChildren,
  getParents,
  getSiblings,
  getSpouses,
  layoutTree,
} from "@/lib/tree";

const STORAGE_KEY = "family-tree-mvp-v1";
const EXAMPLE =
  "I'm Lan. My dad is Minh, born 1960 in Hanoi. He married my mom, Hoa.";

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function describeProposal(
  p: Proposal,
  people: Person[],
  proposals: Proposal[]
): string {
  if (p.kind === "person") {
    const existing = p.tempId ? people.find((x) => x.id === p.tempId) : undefined;
    const name = p.displayName ?? existing?.displayName ?? "Unnamed person";
    const bits: string[] = [];
    if (!existing || (p.displayName && p.displayName !== existing.displayName)) {
      bits.push(name);
    }
    if (p.preferredName && p.preferredName !== name) bits.push(`(${p.preferredName})`);
    if (p.birthYear) bits.push(`born ${p.birthYear}`);
    if (p.birthPlace) bits.push(`in ${p.birthPlace}`);
    if (existing) return `Update ${existing.displayName}: ${bits.join(" ")}`;
    return `Add person: ${bits.join(" ")}`;
  }
  const nameFor = (ref?: string): string => {
    if (!ref) return "someone";
    const existing = people.find((x) => x.id === ref);
    if (existing) return existing.displayName;
    const pending = proposals.find((x) => x.kind === "person" && x.tempId === ref);
    return pending?.displayName ?? "someone";
  };
  const from = nameFor(p.fromRef);
  const to = nameFor(p.toRef);
  if (p.relationshipType === "PARENT_OF") return `${from} is a parent of ${to}`;
  if (p.relationshipType === "SPOUSE_OF") return `${from} is married to ${to}`;
  if (p.relationshipType === "PARTNER_OF") return `${from} is a partner of ${to}`;
  return `${from} is related to ${to}`;
}

export default function Home() {
  const [people, setPeople] = useState<Person[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "Hi! Who are you in this tree? Tell me about yourself first, then your parents — for example, try the example prompt below.",
    },
  ]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [modelNote, setModelNote] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [manualName, setManualName] = useState("");
  const [manualYear, setManualYear] = useState("");
  const [manualPlace, setManualPlace] = useState("");

  const [detailBio, setDetailBio] = useState("");
  const [relativeType, setRelativeType] = useState<"parent" | "spouse" | "child">("parent");
  const [relativeName, setRelativeName] = useState("");

  // Load persisted state (client only, to avoid hydration mismatch).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.people)) setPeople(parsed.people);
        if (Array.isArray(parsed.relationships)) setRelationships(parsed.relationships);
      }
    } catch {
      // Corrupt storage: start fresh rather than crashing.
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ people, relationships }));
    } catch {
      // localStorage full (e.g. large avatar data URLs): ignore, tree
      // still works for this session.
    }
  }, [people, relationships, loaded]);

  const selected = people.find((p) => p.id === selectedId) ?? null;

  useEffect(() => {
    setDetailBio(selected?.bio ?? "");
  }, [selected?.id, selected?.bio]);

  const positioned = useMemo(() => layoutTree(people, relationships), [people, relationships]);
  const posById = useMemo(() => new Map(positioned.map((p) => [p.id, p])), [positioned]);
  const canvasWidth = positioned.length > 0 ? Math.max(...positioned.map((p) => p.x)) + 190 : 400;
  const canvasHeight = positioned.length > 0 ? Math.max(...positioned.map((p) => p.y)) + 104 : 200;

  const parents = selected ? getParents(selected.id, people, relationships) : [];
  const spouses = selected ? getSpouses(selected.id, people, relationships) : [];
  const children = selected ? getChildren(selected.id, people, relationships) : [];
  const siblings = selected ? getSiblings(selected.id, people, relationships) : [];

  async function sendChat(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;
    setMessages((m) => [...m, { id: uid(), role: "user", text }]);
    setInput("");
    setLoading(true);
    try {
      const roster = people.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        preferredName: p.preferredName ?? null,
        birthYear: p.birthYear ?? null,
        birthPlace: p.birthPlace ?? null,
      }));
      const rosterRelationships = relationships.map((r) => ({
        fromPersonId: r.fromPersonId,
        toPersonId: r.toPersonId,
        type: r.type,
      }));
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          roster,
          relationships: rosterRelationships,
          egoId: people[0]?.id ?? null,
        }),
      });
      const data = await res.json();
      setMessages((m) => [
        ...m,
        {
          id: uid(),
          role: "assistant",
          text: typeof data.reply === "string" ? data.reply : "Please review the proposals below.",
        },
      ]);
      if (Array.isArray(data.proposals)) {
        setProposals((prev) => [...prev, ...(data.proposals as Proposal[])]);
      }
      if (typeof data.modelUsed === "string") setModelNote(data.modelUsed);
    } catch {
      setMessages((m) => [
        ...m,
        {
          id: uid(),
          role: "assistant",
          text: "Sorry, I couldn't reach the chat service. You can still add people manually on the right.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  // Apply one or more proposals, resolving tempIds / existing ids.
  // Existing people are matched by case-insensitive name so a
  // same-name person is never silently duplicated.
  function applyProposals(toApply: Proposal[]) {
    let nextPeople = [...people];
    let nextRels = [...relationships];
    let nextProps = [...proposals];
    let lastCreatedId: string | null = null;

    const ensurePerson = (ref?: string): string | null => {
      if (!ref) return null;
      const existing = nextPeople.find((x) => x.id === ref);
      if (existing) return existing.id;
      const pending = nextProps.find((x) => x.kind === "person" && x.tempId === ref);
      if (pending) {
        const created: Person = {
          id: uid(),
          displayName: pending.displayName ?? "Unnamed person",
          preferredName: pending.preferredName ?? null,
          birthYear: pending.birthYear ?? null,
          birthPlace: pending.birthPlace ?? null,
          bio: pending.bio ?? null,
        };
        nextPeople = [...nextPeople, created];
        nextProps = nextProps.filter((x) => x !== pending);
        lastCreatedId = created.id;
        return created.id;
      }
      return null;
    };

    for (const p of toApply) {
      if (p.kind === "person") {
        const target = p.tempId ? nextPeople.find((x) => x.id === p.tempId) : undefined;
        if (target) {
          const displayName = p.displayName ?? target.displayName;
          const updated: Person = {
            ...target,
            displayName,
            preferredName:
              p.preferredName ??
              (target.preferredName || (target.displayName !== displayName ? target.displayName : null)),
            birthYear: p.birthYear ?? target.birthYear ?? null,
            birthPlace: p.birthPlace ?? target.birthPlace ?? null,
            bio: p.bio ?? target.bio ?? null,
          };
          nextPeople = nextPeople.map((x) => (x.id === target.id ? updated : x));
          nextProps = nextProps.filter((x) => x !== p);
          continue;
        }
        if (!p.displayName) continue;
        const byName = nextPeople.find(
          (x) => x.displayName.toLowerCase() === p.displayName!.toLowerCase()
        );
        if (byName) {
          if (p.tempId) {
            // Point any relationship proposals at the existing person
            // by treating the tempId as resolved in ensurePerson's
            // fallback below — handled by the name check on accept
            // of the relationship via nextProps removal only.
          }
        } else {
          const created: Person = {
            id: uid(),
            displayName: p.displayName,
            preferredName: p.preferredName ?? null,
            birthYear: p.birthYear ?? null,
            birthPlace: p.birthPlace ?? null,
            bio: p.bio ?? null,
          };
          nextPeople = [...nextPeople, created];
          lastCreatedId = created.id;
        }
        nextProps = nextProps.filter((x) => x !== p);
      } else if (p.kind === "relationship") {
        // If a side refers to a tempId whose person proposal was
        // already name-matched to an existing person, resolve by name.
        let fromId = ensurePerson(p.fromRef);
        let toId = ensurePerson(p.toRef);
        if (!fromId && p.fromRef) {
          const pending = proposals.find((x) => x.kind === "person" && x.tempId === p.fromRef);
          if (pending?.displayName) {
            const byName = nextPeople.find(
              (x) => x.displayName.toLowerCase() === pending.displayName!.toLowerCase()
            );
            fromId = byName?.id ?? null;
          }
        }
        if (!toId && p.toRef) {
          const pending = proposals.find((x) => x.kind === "person" && x.tempId === p.toRef);
          if (pending?.displayName) {
            const byName = nextPeople.find(
              (x) => x.displayName.toLowerCase() === pending.displayName!.toLowerCase()
            );
            toId = byName?.id ?? null;
          }
        }
        if (fromId && toId && fromId !== toId) {
          const duplicate = nextRels.some(
            (r) =>
              r.type === p.relationshipType &&
              ((r.fromPersonId === fromId && r.toPersonId === toId) ||
                (p.relationshipType !== "PARENT_OF" &&
                  r.fromPersonId === toId &&
                  r.toPersonId === fromId))
          );
          if (!duplicate && p.relationshipType) {
            nextRels = [
              ...nextRels,
              { id: uid(), fromPersonId: fromId, toPersonId: toId, type: p.relationshipType },
            ];
          }
        }
        nextProps = nextProps.filter((x) => x !== p);
      }
    }

    setPeople(nextPeople);
    setRelationships(nextRels);
    setProposals(nextProps);
    if (lastCreatedId) setSelectedId(lastCreatedId);
  }

  function manualAdd(e: React.FormEvent) {
    e.preventDefault();
    const name = manualName.trim();
    if (!name) return;
    const year = manualYear.trim() ? Number(manualYear.trim()) : null;
    const person: Person = {
      id: uid(),
      displayName: name,
      birthYear: Number.isFinite(year) ? year : null,
      birthPlace: manualPlace.trim() || null,
    };
    setPeople((prev) => [...prev, person]);
    setSelectedId(person.id);
    setManualName("");
    setManualYear("");
    setManualPlace("");
  }

  function addRelative(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const name = relativeName.trim();
    if (!name) return;
    const person: Person = { id: uid(), displayName: name };
    let rel: Relationship;
    if (relativeType === "parent") {
      rel = { id: uid(), fromPersonId: person.id, toPersonId: selected.id, type: "PARENT_OF" };
    } else if (relativeType === "spouse") {
      rel = { id: uid(), fromPersonId: selected.id, toPersonId: person.id, type: "SPOUSE_OF" };
    } else {
      rel = { id: uid(), fromPersonId: selected.id, toPersonId: person.id, type: "PARENT_OF" };
    }
    setPeople((prev) => [...prev, person]);
    setRelationships((prev) => [...prev, rel]);
    setSelectedId(person.id);
    setRelativeName("");
  }

  function saveBio() {
    if (!selected) return;
    setPeople((prev) =>
      prev.map((p) => (p.id === selected.id ? { ...p, bio: detailBio } : p))
    );
  }

  function uploadAvatar(file: File | undefined) {
    if (!selected || !file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : null;
      if (!url) return;
      setPeople((prev) =>
        prev.map((p) => (p.id === selected.id ? { ...p, avatarUrl: url } : p))
      );
    };
    reader.readAsDataURL(file);
  }

  function deletePerson(id: string) {
    setPeople((prev) => prev.filter((p) => p.id !== id));
    setRelationships((prev) =>
      prev.filter((r) => r.fromPersonId !== id && r.toPersonId !== id)
    );
    if (selectedId === id) setSelectedId(null);
  }

  return (
    <div className="app">
      <header className="header">
        <h1>🌼 Family Tree — built by talking</h1>
        <p>
          Tell me about your family in chat. I&apos;ll propose people and
          relationships — nothing enters the tree until you accept it.
        </p>
        <div className="model-note">
          {modelNote
            ? `Last extraction used: ${modelNote}.`
            : "Model: Ollama (open-weight, local) when it is running — otherwise the built-in fallback parser."}{" "}
          Your tree is saved in this browser only in this MVP.
        </div>
      </header>

      <div className="main">
        <section className="chat">
          <div className="messages">
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                {m.text}
              </div>
            ))}
            {loading && <div className="msg assistant">Thinking…</div>}
          </div>

          {proposals.length > 0 && (
            <div className="proposals">
              <h3>Proposals — review before they enter the tree</h3>
              {proposals.map((p) => (
                <div key={p.id} className="proposal">
                  <p>{describeProposal(p, people, proposals)}</p>
                  <small>
                    Confidence: {p.confidence} · {p.reason}
                  </small>
                  <div className="row">
                    <button className="btn btn-primary btn-small" onClick={() => applyProposals([p])}>
                      Accept
                    </button>
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={() => setProposals((prev) => prev.filter((x) => x.id !== p.id))}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
              <div className="row">
                <button className="btn btn-primary btn-small" onClick={() => applyProposals([...proposals])}>
                  Accept all
                </button>
                <button className="btn btn-secondary btn-small" onClick={() => setProposals([])}>
                  Reject all
                </button>
              </div>
            </div>
          )}

          <form className="chat-form" onSubmit={sendChat}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. My dad is Minh, born 1960 in Hanoi…"
            />
            <button type="button" className="example-btn" onClick={() => setInput(EXAMPLE)}>
              Try the example: “I&apos;m Lan. My dad is Minh, born 1960 in Hanoi. He married my mom, Hoa.”
            </button>
            <button className="btn btn-primary" type="submit" disabled={loading || !input.trim()}>
              {loading ? "Working…" : "Send"}
            </button>
          </form>
        </section>

        <section className="tree-area">
          <h2>Your tree</h2>
          <p className="hint">Click a person to see details, edit their story, or add a photo.</p>

          {people.length === 0 ? (
            <div className="empty">
              No one in the tree yet. Say hello in chat, or add someone manually below.
            </div>
          ) : (
            <div className="tree-scroll">
              <div className="tree-canvas" style={{ width: canvasWidth, height: canvasHeight }}>
                <svg
                  width={canvasWidth}
                  height={canvasHeight}
                  style={{ position: "absolute", top: 0, left: 0 }}
                >
                  {relationships.map((r) => {
                    const from = posById.get(r.fromPersonId);
                    const to = posById.get(r.toPersonId);
                    if (!from || !to) return null;
                    if (r.type === "PARENT_OF") {
                      return (
                        <line
                          key={r.id}
                          x1={from.x + 95}
                          y1={from.y + 104}
                          x2={to.x + 95}
                          y2={to.y}
                          stroke="#cbb89f"
                          strokeWidth={2}
                        />
                      );
                    }
                    // Spouse / partner: dashed line between the nodes.
                    const left = from.x <= to.x ? from : to;
                    const right = from.x <= to.x ? to : from;
                    return (
                      <line
                        key={r.id}
                        x1={left.x + 190}
                        y1={left.y + 52}
                        x2={right.x}
                        y2={right.y + 52}
                        stroke="#e08a00"
                        strokeWidth={2}
                        strokeDasharray="6 4"
                      />
                    );
                  })}
                </svg>
                {positioned.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`tree-node ${selectedId === p.id ? "selected" : ""}`}
                    style={{ left: p.x, top: p.y }}
                    onClick={() => setSelectedId(p.id)}
                  >
                    {p.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="avatar" src={p.avatarUrl} alt="" />
                    ) : (
                      <span className="initials">{initials(p.displayName)}</span>
                    )}
                    <span className="name">{p.displayName}</span>
                    <div className="meta">
                      {p.birthYear ? `Born ${p.birthYear}` : ""}
                      {p.birthYear && p.birthPlace ? " · " : ""}
                      {p.birthPlace ?? ""}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="panels">
            <div className="panel">
              <h3>{selected ? `Details: ${selected.displayName}` : "Details"}</h3>
              {!selected ? (
                <p className="empty">Click a person in the tree.</p>
              ) : (
                <>
                  <p>
                    {selected.birthYear ? `Born ${selected.birthYear}` : "Birth year unknown"}
                    {selected.birthPlace ? ` in ${selected.birthPlace}` : ""}
                  </p>
                  {selected.preferredName &&
                    selected.preferredName !== selected.displayName && (
                      <p>
                        <strong>Also known as:</strong> {selected.preferredName}
                      </p>
                    )}
                  <p>
                    <strong>Parents:</strong>{" "}
                    {parents.length > 0
                      ? parents.map((p) => p.displayName).join(", ")
                      : "—"}
                  </p>
                  <p>
                    <strong>Spouse / partner:</strong>{" "}
                    {spouses.length > 0
                      ? spouses.map((p) => p.displayName).join(", ")
                      : "—"}
                  </p>
                  <p>
                    <strong>Children:</strong>{" "}
                    {children.length > 0
                      ? children.map((p) => p.displayName).join(", ")
                      : "—"}
                  </p>
                  <p>
                    <strong>Siblings (derived):</strong>{" "}
                    {siblings.length > 0
                      ? siblings.map((p) => p.displayName).join(", ")
                      : "—"}
                  </p>

                  <label htmlFor="bio">Story / bio</label>
                  <textarea
                    id="bio"
                    value={detailBio}
                    onChange={(e) => setDetailBio(e.target.value)}
                    placeholder="A memory, a favourite food, a story about this person…"
                  />
                  <div className="row">
                    <button className="btn btn-primary btn-small" type="button" onClick={saveBio}>
                      Save story
                    </button>
                  </div>

                  <label htmlFor="avatar">Photo / avatar</label>
                  <input
                    id="avatar"
                    type="file"
                    accept="image/*"
                    onChange={(e) => uploadAvatar(e.target.files?.[0])}
                  />

                  <form onSubmit={addRelative}>
                    <label htmlFor="relative-type">Add a relative</label>
                    <select
                      id="relative-type"
                      value={relativeType}
                      onChange={(e) => setRelativeType(e.target.value as "parent" | "spouse" | "child")}
                    >
                      <option value="parent">Parent</option>
                      <option value="spouse">Spouse / partner</option>
                      <option value="child">Child</option>
                    </select>
                    <label htmlFor="relative-name">Name</label>
                    <input
                      id="relative-name"
                      type="text"
                      value={relativeName}
                      onChange={(e) => setRelativeName(e.target.value)}
                      placeholder="e.g. Tuan"
                    />
                    <div className="row">
                      <button className="btn btn-primary btn-small" type="submit">
                        Add relative
                      </button>
                      <button
                        className="btn btn-secondary btn-small"
                        type="button"
                        onClick={() => deletePerson(selected.id)}
                      >
                        Delete person
                      </button>
                    </div>
                  </form>
                </>
              )}
            </div>

            <div className="panel">
              <h3>Add a person manually</h3>
              <p>Useful when chat gets something wrong — you can always fix the tree by hand.</p>
              <form onSubmit={manualAdd}>
                <label htmlFor="manual-name">Name</label>
                <input
                  id="manual-name"
                  type="text"
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  placeholder="e.g. Nguyen Van Minh"
                />
                <label htmlFor="manual-year">Birth year (optional)</label>
                <input
                  id="manual-year"
                  type="number"
                  value={manualYear}
                  onChange={(e) => setManualYear(e.target.value)}
                  placeholder="1960"
                />
                <label htmlFor="manual-place">Birthplace (optional)</label>
                <input
                  id="manual-place"
                  type="text"
                  value={manualPlace}
                  onChange={(e) => setManualPlace(e.target.value)}
                  placeholder="Hanoi"
                />
                <div className="row">
                  <button className="btn btn-primary btn-small" type="submit">
                    Add person
                  </button>
                </div>
              </form>
              <p style={{ color: "var(--muted)", fontSize: 13 }}>
                Tip: after adding someone manually, click them in the tree and use
                “Add a relative” to link parents, spouses, and children.
              </p>
            </div>
          </div>
        </section>
      </div>

      <footer className="footer-note">
        MVP note: the tree lives in this browser&apos;s localStorage. For a shared
        or deployed version, swap that for a database (see README). When Ollama is
        running locally, extraction uses your open-weight model; otherwise the
        deterministic fallback parser runs so the demo still works.
      </footer>
    </div>
  );
}

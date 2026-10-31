"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ExtractionDebug, Gender, Person, Photo, Proposal, Relationship } from "@/lib/types";
import {
  familyConnectors,
  getChildren,
  getParents,
  getSiblings,
  getSpouses,
  layoutTree,
  relationLabel,
  type LayoutSize,
} from "@/lib/tree";
import { DownloadIcon, PhotoIcon, ResetIcon, UploadIcon, UserPlusIcon } from "./icons";
import {
  applyProposalBatch,
  batchOf,
  describeProposal,
  initials,
  rejectProposalBatch,
  sameNamePerson,
  scopeBatch,
  uid,
  type TreeState,
} from "@/lib/proposals";
import { birthLabel, yearOf } from "@/lib/dates";
import {
  LOCATION_NAME,
  isModelLocation,
  modelLocation,
  modelStatus,
  type ModelConfig,
} from "@/lib/model-location";
import { matchPeople, relativeCandidates, type RelativeKind } from "@/lib/people-search";
import { resizeImage, shrinkImage } from "@/lib/images";
import {
  deletePhotoBlobs,
  getPhotoBlob,
  isQuotaError,
  pruneOrphanPhotoBlobs,
  putPhotoBlobs,
  requestPersistence,
} from "@/lib/photo-store";
import { PhotoGrid, PhotoViewer, Slideshow, TreeGalleryDialog } from "./photos";
import { MAX_FILE_BYTES, exportFileName, parseTreeFile, serializeTree, type TreeFile } from "@/lib/tree-file";

const STORAGE_KEY = "family-tree-mvp-v1";
const CHAT_KEY = "family-tree-mvp-v1-chat";
const LAYOUT_KEY = "family-tree-mvp-v1-layout";
const SNAP = 8;
const EXAMPLE = "I'm Lan. My dad is Minh, born 1960 in Hanoi. He married my mom, Hoa.";
const FRESH_WELCOME = "Hi! Let's start with you. Tell me your name, then your parents — like the example below.";
const SIZE: LayoutSize = { nodeW: 184, nodeH: 64, hGap: 24, vGap: 64 };
const PAD = 32;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.6;

type Message = ChatMessage & { batchId?: string; tone?: "error" | "muted"; debug?: ExtractionDebug };
type Toast = { label: string; onUndo?: () => void };
type Point = { x: number; y: number };
type DragState = { id: string; startX: number; startY: number; origin: Point; at: Point; moved: boolean };
type PanState = { pointerId: number; startX: number; startY: number; origin: Point; moved: boolean; onBackground: boolean };
type QuickAdd = { kind: RelativeKind; name: string; withPartner: boolean };
type PendingImport = { file: TreeFile; name: string };

const KIND_LABEL: Record<RelativeKind, string> = {
  parent: "Parent",
  partner: "Partner",
  child: "Child",
  sibling: "Sibling",
};

function readModelConfig(data: unknown): ModelConfig | null {
  if (!data || typeof data !== "object") return null;
  const { where, model } = data as Record<string, unknown>;
  return isModelLocation(where) && typeof model === "string" ? { where, model } : null;
}

function formatMs(ms?: number): string {
  if (ms === undefined) return "?";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function DebugInfo({ debug }: { debug: ExtractionDebug }) {
  const viaOllama = debug.source === "ollama";
  const counts =
    debug.returned !== undefined ? `${debug.kept} of ${debug.returned} kept` : `${debug.kept} proposal(s)`;
  const summary = viaOllama
    ? `${LOCATION_NAME[modelLocation(debug.host)]} · ${debug.model} · ${formatMs(debug.ollamaMs)} · ${counts}`
    : `Built-in parser · ${counts} · Ollama: ${debug.ollamaError ?? "not used"}`;
  const rows: [string, string | number | undefined][] = [
    ["Source", viaOllama ? `ollama:${debug.model}` : "fallback (rule-based)"],
    ["Ollama host", debug.host],
    ["Ollama error", debug.ollamaError],
    ["Ollama time", debug.ollamaMs !== undefined ? formatMs(debug.ollamaMs) : undefined],
    ["Fallback time", debug.fallbackMs !== undefined ? formatMs(debug.fallbackMs) : undefined],
    ["Total time", formatMs(debug.totalMs)],
    ["Tokens", debug.promptTokens !== undefined ? `${debug.promptTokens} in / ${debug.outputTokens ?? "?"} out` : undefined],
    ["Done reason", debug.doneReason],
    ["Proposals", counts],
  ];
  return (
    <details className={`pt-debug ${viaOllama ? "ollama" : "fallback"}`}>
      <summary>{summary}</summary>
      <dl>
        {rows
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>
      {debug.rawOutput && <pre>{debug.rawOutput}</pre>}
    </details>
  );
}

function personMeta(p: Pick<Person, "birthYear" | "birthDate" | "birthPlace">): string {
  const born = birthLabel(p);
  return [born ? `b. ${born}` : null, p.birthPlace].filter(Boolean).join(" · ");
}

function relativeEdges(
  anchorId: string,
  newId: string,
  kind: RelativeKind,
  rels: Relationship[],
  coParentId: string | null
): Relationship[] {
  const edge = (from: string, to: string, type: Relationship["type"]): Relationship => ({
    id: uid(),
    fromPersonId: from,
    toPersonId: to,
    type,
  });
  if (kind === "parent") return [edge(newId, anchorId, "PARENT_OF")];
  if (kind === "partner") return [edge(anchorId, newId, "SPOUSE_OF")];
  if (kind === "child") {
    return [anchorId, coParentId]
      .filter((id): id is string => !!id)
      .map((id) => edge(id, newId, "PARENT_OF"));
  }
  // A sibling shares the anchor's parents when they are known, so the
  // tree draws them under the same family bar.
  const parentIds = rels
    .filter((r) => r.type === "PARENT_OF" && r.toPersonId === anchorId)
    .map((r) => r.fromPersonId);
  return parentIds.length > 0
    ? parentIds.map((id) => edge(id, newId, "PARENT_OF"))
    : [edge(anchorId, newId, "SIBLING_OF")];
}

export default function Home() {
  const [people, setPeople] = useState<Person[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [egoId, setEgoId] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [showPhotos, setShowPhotos] = useState(false);
  const [viewPhotoId, setViewPhotoId] = useState<string | null>(null);
  const [slideshowIds, setSlideshowIds] = useState<string[] | null>(null);
  // Which gallery is uploading: a person id, or "tree" for the family gallery.
  const [photoBusy, setPhotoBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [resolvedRefs, setResolvedRefs] = useState<Record<string, string>>({});
  const [modelNote, setModelNote] = useState<string | null>(null);
  const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [sameAs, setSameAs] = useState<Record<string, string>>({});
  const [hoverId, setHoverId] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quickAdd, setQuickAdd] = useState<QuickAdd | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [recentIds, setRecentIds] = useState<Set<string>>(new Set());
  // Screen offset (x, y) and scale of the tree stage inside the canvas.
  // Kept in one state so zooming around a point updates both atomically.
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const zoom = view.zoom;
  const panRef = useRef<PanState | null>(null);
  const [panning, setPanning] = useState(false);
  const [refit, setRefit] = useState(0);
  // Positions the user dragged to, in layout coordinates. People
  // without an entry keep their auto-layout spot.
  const [manualPos, setManualPos] = useState<Record<string, Point>>({});
  const [drag, setDrag] = useState<DragState | null>(null);
  // Pointer events can fire faster than React re-renders, so handlers
  // read the live drag from this ref; `drag` state is only for paint.
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const [mobileTab, setMobileTab] = useState<"chat" | "tree">("chat");

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Load persisted state (client only, to avoid hydration mismatch).
  useEffect(() => {
    let savedPeople: Person[] = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.people)) savedPeople = parsed.people;
        if (Array.isArray(parsed.relationships)) setRelationships(parsed.relationships);
        if (typeof parsed.egoId === "string") setEgoId(parsed.egoId);
        const savedPhotos: Photo[] = Array.isArray(parsed.photos) ? parsed.photos : [];
        pruneOrphanPhotoBlobs(new Set(savedPhotos.map((ph) => ph.id))).catch(() => {});
        if (Array.isArray(parsed.photos)) {
          // Undo can't outlive a reload, so tags of deleted people can go.
          const live = new Set(savedPeople.map((p) => p.id));
          setPhotos(
            (parsed.photos as Photo[]).map((ph) => ({
              ...ph,
              personIds: (ph.personIds ?? []).filter((id) => live.has(id)),
            }))
          );
        }
      }
      setPeople(savedPeople);
      const chatRaw = localStorage.getItem(CHAT_KEY);
      if (chatRaw) {
        const chat = JSON.parse(chatRaw);
        if (Array.isArray(chat.messages)) setMessages(chat.messages);
        if (Array.isArray(chat.proposals)) setProposals(chat.proposals);
        if (chat.resolvedRefs && typeof chat.resolvedRefs === "object") setResolvedRefs(chat.resolvedRefs);
        if (typeof chat.modelNote === "string") setModelNote(chat.modelNote);
      }
      const layoutRaw = localStorage.getItem(LAYOUT_KEY);
      if (layoutRaw) {
        const layout = JSON.parse(layoutRaw);
        if (layout && typeof layout === "object") setManualPos(layout);
      }
    } catch {
      // Corrupt storage: start fresh rather than crashing.
    }
    setMessages((m) =>
      m.length > 0
        ? m
        : [
            {
              id: "welcome",
              role: "assistant",
              text:
                savedPeople.length > 0
                  ? `Welcome back — your tree has ${savedPeople.length} ${savedPeople.length === 1 ? "person" : "people"}. Tell me about someone new, or click a person to edit them.`
                  : FRESH_WELCOME,
            },
          ]
    );
    setLoaded(true);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/chat", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const config = readModelConfig(data);
        if (config) setModelConfig(config);
      })
      .catch(() => {
        // The pill keeps its generic label; the next chat reply fills it in.
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ people, relationships, egoId, photos }));
    } catch {
      showToast({ label: "Couldn't save — browser storage is full." });
    }
  }, [people, relationships, egoId, photos, loaded]);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(
        CHAT_KEY,
        JSON.stringify({ messages: messages.slice(-60), proposals, resolvedRefs, modelNote })
      );
    } catch {
      // Chat history is a convenience; the tree itself is saved above.
    }
  }, [messages, proposals, resolvedRefs, modelNote, loaded]);

  useEffect(() => {
    if (!loaded) return;
    try {
      const live = new Set(people.map((p) => p.id));
      const kept = Object.fromEntries(Object.entries(manualPos).filter(([id]) => live.has(id)));
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(kept));
    } catch {
      // Positions are cosmetic; auto-layout still works without them.
    }
  }, [manualPos, people, loaded]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, proposals.length, loading]);

  useEffect(() => {
    if (!loading) return;
    const started = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [loading]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (recentIds.size === 0) return;
    const t = setTimeout(() => setRecentIds(new Set()), 2400);
    return () => clearTimeout(t);
  }, [recentIds]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pendingImport) setPendingImport(null);
      else if (confirmReset) setConfirmReset(false);
      else if (slideshowIds) setSlideshowIds(null);
      else if (viewPhotoId) setViewPhotoId(null);
      else if (showPhotos) setShowPhotos(false);
      else if (showAdd) setShowAdd(false);
      else if (quickAdd) setQuickAdd(null);
      else setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingImport, confirmReset, slideshowIds, viewPhotoId, showPhotos, showAdd, quickAdd]);

  useEffect(() => {
    setQuickAdd(null);
  }, [selectedId]);

  function showToast(t: Toast) {
    setToast(t);
  }

  const snapshot = (): TreeState => ({ people, relationships, proposals, resolvedRefs, egoId });

  function commit(next: TreeState, label: string | null, before?: TreeState) {
    setPeople(next.people);
    setRelationships(next.relationships);
    setProposals(next.proposals);
    setResolvedRefs(next.resolvedRefs);
    setEgoId(next.egoId);
    if (label) showToast({ label, onUndo: before ? () => commit(before, null) : undefined });
  }

  function undo() {
    toast?.onUndo?.();
    setToast(null);
  }

  // --- Proposal review -------------------------------------------------

  const uncheckedRefs = useMemo(
    () =>
      new Set(
        proposals
          .filter((p) => p.kind === "person" && p.tempId && unchecked.has(p.id))
          .map((p) => p.tempId as string)
      ),
    [proposals, unchecked]
  );

  const isChecked = (p: Proposal) =>
    !unchecked.has(p.id) &&
    !(p.kind === "relationship" &&
      ((p.fromRef && uncheckedRefs.has(p.fromRef)) || (p.toRef && uncheckedRefs.has(p.toRef))));

  function toggle(p: Proposal) {
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(p.id)) next.delete(p.id);
      else next.add(p.id);
      return next;
    });
  }

  // The tree shows checked proposals as dashed "ghost" nodes, so the
  // user sees where people will land before they accept anything.
  const preview = useMemo(() => {
    const existing = new Set(people.map((p) => p.id));
    const alias: Record<string, string> = { ...resolvedRefs };
    const pendingPeople: Person[] = [];
    const pendingIds = new Set<string>();
    const updatingIds = new Set<string>();
    for (const p of proposals) {
      if (p.kind !== "person" || !isChecked(p)) continue;
      const merge = sameAs[p.id];
      const target = merge ?? (p.tempId ? alias[p.tempId] ?? p.tempId : undefined);
      if (target && existing.has(target)) {
        if (p.tempId) alias[p.tempId] = target;
        updatingIds.add(target);
        continue;
      }
      if (!p.displayName) continue;
      const id = p.tempId ?? p.id;
      pendingPeople.push({
        id,
        displayName: p.displayName,
        birthYear: p.birthYear ?? null,
        birthDate: p.birthDate ?? null,
        birthPlace: p.birthPlace ?? null,
        gender: p.gender ?? null,
      });
      pendingIds.add(id);
    }
    const known = (id: string) => existing.has(id) || pendingIds.has(id);
    const pendingRels: Relationship[] = [];
    for (const p of proposals) {
      if (p.kind !== "relationship" || !isChecked(p) || !p.relationshipType) continue;
      const from = p.fromRef ? alias[p.fromRef] ?? p.fromRef : null;
      const to = p.toRef ? alias[p.toRef] ?? p.toRef : null;
      if (!from || !to || from === to || !known(from) || !known(to)) continue;
      pendingRels.push({ id: p.id, fromPersonId: from, toPersonId: to, type: p.relationshipType });
    }
    const proposalByNode = new Map<string, string>();
    for (const p of proposals) {
      if (p.kind !== "person") continue;
      const node = sameAs[p.id] ?? (p.tempId ? alias[p.tempId] ?? p.tempId : p.id);
      proposalByNode.set(p.id, node);
    }
    return { pendingPeople, pendingIds, updatingIds, pendingRels, proposalByNode };
    // isChecked is derived from unchecked + uncheckedRefs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, proposals, resolvedRefs, sameAs, unchecked, uncheckedRefs]);

  const allPeople = useMemo(() => [...people, ...preview.pendingPeople], [people, preview]);
  const allRels = useMemo(() => [...relationships, ...preview.pendingRels], [relationships, preview]);
  const viewEgo =
    egoId ??
    proposals.find((p) => p.isSpeaker && isChecked(p))?.tempId ??
    null;

  function acceptBatch(batchId: string) {
    const items = proposals.filter((p) => batchOf(p) === batchId);
    const chosen = items
      .filter(isChecked)
      .map((p) => (sameAs[p.id] ? { ...p, existingPersonId: sameAs[p.id] } : p));
    const dropped = items.filter((p) => !isChecked(p));
    const before = snapshot();
    const { next, skipped } = applyProposalBatch(before, chosen);
    const after = { ...next, proposals: rejectProposalBatch(next, dropped) };
    const added = after.people.filter((p) => !before.people.some((x) => x.id === p.id));
    const links = after.relationships.length - before.relationships.length;
    commit(
      after,
      [
        added.length ? `Added ${added.length} ${added.length === 1 ? "person" : "people"}` : null,
        links ? `${links} ${links === 1 ? "link" : "links"}` : null,
      ]
        .filter(Boolean)
        .join(" and ") || "Tree updated",
      before
    );
    setRecentIds(new Set(added.map((p) => p.id)));
    if (skipped.length) {
      setMessages((m) => [
        ...m,
        ...skipped.map((text) => ({ id: uid(), role: "assistant" as const, text, tone: "error" as const })),
      ]);
    }
  }

  function discardBatch(batchId: string) {
    const before = snapshot();
    const items = proposals.filter((p) => batchOf(p) === batchId);
    commit({ ...before, proposals: rejectProposalBatch(before, items) }, "Suggestions discarded", before);
  }

  // --- Chat ------------------------------------------------------------

  async function sendChat(e?: React.FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || loading) return;
    setMessages((m) => [...m, { id: uid(), role: "user", text }]);
    setInput("");
    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const roster = people.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        preferredName: p.preferredName ?? null,
        birthYear: p.birthYear ?? null,
        birthDate: p.birthDate ?? null,
        birthPlace: p.birthPlace ?? null,
        gender: p.gender ?? null,
      }));
      const graph = relationships.map((r) => ({
        fromPersonId: r.fromPersonId,
        toPersonId: r.toPersonId,
        type: r.type,
      }));
      const history = [...messages.filter((m) => !m.tone), { role: "user" as const, text }]
        .slice(-8)
        .map((m) => ({ role: m.role, text: m.text }));
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          message: text,
          roster,
          relationships: graph,
          history,
          egoId: egoId ?? people[0]?.id ?? null,
        }),
      });
      const data = await res.json();
      const prefix = uid().slice(0, 8);
      const batch = Array.isArray(data.proposals)
        ? scopeBatch(data.proposals as Proposal[], people, prefix)
        : [];
      setMessages((m) => [
        ...m,
        {
          id: uid(),
          role: "assistant",
          text:
            typeof data.reply === "string"
              ? data.reply
              : batch.length
                ? "Here's what I understood — check it before it goes in the tree."
                : "I didn't find anyone new in that. Try naming the person and how they're related to you.",
          batchId: batch.length ? prefix : undefined,
          debug: data.debug && typeof data.debug === "object" ? (data.debug as ExtractionDebug) : undefined,
        },
      ]);
      if (batch.length) {
        setProposals((prev) => [...prev, ...batch]);
        setUnchecked((prev) => {
          const next = new Set(prev);
          for (const p of batch) if (p.confidence === "low") next.add(p.id);
          return next;
        });
        setMobileTab("chat");
      }
      if (typeof data.modelUsed === "string") setModelNote(data.modelUsed);
      const config = readModelConfig(data);
      if (config) setModelConfig(config);
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      setMessages((m) => [
        ...m,
        {
          id: uid(),
          role: "assistant",
          tone: aborted ? "muted" : "error",
          text: aborted
            ? "Stopped. Your message is back in the box if you want to edit it."
            : "I couldn't reach the chat service. Your message is back in the box — try again, or add people by hand with “+ Person”.",
        },
      ]);
      setInput((cur) => cur || text);
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }

  const selected = people.find((p) => p.id === selectedId) ?? null;
  const viewingPhoto = photos.find((p) => p.id === viewPhotoId) ?? null;
  const slideshowPhotos = useMemo(
    () =>
      slideshowIds
        ? slideshowIds.map((id) => photos.find((p) => p.id === id)).filter((p): p is Photo => Boolean(p))
        : null,
    [slideshowIds, photos]
  );
  const firstName = (p: Person) => p.preferredName || p.displayName.split(/\s+/).slice(-1)[0];
  const ego = people.find((p) => p.id === egoId) ?? null;

  const suggestions: string[] = useMemo(() => {
    if (people.length === 0) return [EXAMPLE, "My name is "];
    if (selected) {
      const n = firstName(selected);
      return [`${n}'s parents are `, `${n} is married to `, `${n}'s children are `];
    }
    if (ego && getParents(ego.id, people, relationships).length === 0) {
      return ["My parents are ", "My dad is ", "My mom is "];
    }
    return ["My grandparents are ", "My brother is ", "My sister is "];
  }, [people, relationships, selected, ego]);

  function applySuggestion(s: string) {
    setInput(s);
    setMobileTab("chat");
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(s.length, s.length);
    });
  }

  // --- Tree editing ----------------------------------------------------

  function patchPerson(id: string, patch: Partial<Person>) {
    setPeople((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function addRelative(
    anchorId: string | null,
    kind: RelativeKind,
    fields: Pick<Person, "displayName" | "birthYear" | "birthDate" | "birthPlace">,
    coParentId: string | null = null
  ) {
    const before = snapshot();
    const person: Person = { id: uid(), ...fields };
    const edges = anchorId ? relativeEdges(anchorId, person.id, kind, relationships, coParentId) : [];
    commit(
      { ...before, people: [...people, person], relationships: [...relationships, ...edges] },
      `Added ${person.displayName}`,
      before
    );
    setRecentIds(new Set([person.id]));
    return person.id;
  }

  function linkRelative(anchorId: string, kind: RelativeKind, existingId: string, coParentId: string | null) {
    const before = snapshot();
    const exists = (e: Relationship) =>
      relationships.some(
        (r) => r.type === e.type && r.fromPersonId === e.fromPersonId && r.toPersonId === e.toPersonId
      );
    const edges = relativeEdges(anchorId, existingId, kind, relationships, coParentId).filter((e) => !exists(e));
    if (edges.length === 0) return;
    const name = people.find((p) => p.id === existingId)?.displayName ?? "person";
    commit({ ...before, relationships: [...relationships, ...edges] }, `Linked ${name}`, before);
    setRecentIds(new Set([existingId]));
  }

  function deletePerson(id: string) {
    const before = snapshot();
    const name = people.find((p) => p.id === id)?.displayName ?? "person";
    commit(
      {
        ...before,
        people: people.filter((p) => p.id !== id),
        relationships: relationships.filter((r) => r.fromPersonId !== id && r.toPersonId !== id),
        egoId: egoId === id ? null : egoId,
      },
      `Deleted ${name}`,
      before
    );
    setSelectedId(null);
  }

  async function uploadAvatar(id: string, file: File | undefined) {
    if (!file) return;
    try {
      patchPerson(id, { avatarUrl: await shrinkImage(file) });
    } catch {
      showToast({ label: "That file couldn't be read as an image." });
    }
  }

  // --- Photos ------------------------------------------------------------

  async function addPhotos(files: File[], personIds: string[]) {
    setPhotoBusy(personIds[0] ?? "tree");
    requestPersistence();
    const added: Photo[] = [];
    let unreadable = 0;
    let problem: string | null = null;
    try {
      for (const file of files) {
        let full, thumb;
        try {
          full = await resizeImage(file, 2000);
          thumb = await resizeImage(full.blob, 400);
        } catch {
          unreadable++;
          continue;
        }
        const id = uid();
        await putPhotoBlobs(id, { full: full.blob, thumb: thumb.blob });
        added.push({ id, personIds, width: full.width, height: full.height, createdAt: new Date().toISOString() });
      }
    } catch (err) {
      problem = isQuotaError(err) ? "Couldn't save — browser storage is full." : "Couldn't save that photo.";
    }
    if (added.length) setPhotos((prev) => [...prev, ...added]);
    setPhotoBusy(null);
    if (problem) showToast({ label: problem });
    else if (unreadable) {
      showToast({
        label:
          unreadable === files.length
            ? "That file couldn't be read as an image."
            : `${unreadable} of ${files.length} files couldn't be read as images.`,
      });
    }
  }

  function updatePhoto(id: string, patch: Partial<Photo>) {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function deletePhoto(id: string) {
    setPhotos((prev) => prev.filter((p) => p.id !== id));
    setViewPhotoId(null);
    deletePhotoBlobs(id).catch(() => {});
    showToast({ label: "Photo deleted" });
  }

  async function setAvatarFromPhoto(photoId: string, personId: string) {
    try {
      const blob = await getPhotoBlob(photoId, "full");
      if (!blob) throw new Error("missing photo");
      patchPerson(personId, { avatarUrl: await shrinkImage(blob) });
      const name = people.find((p) => p.id === personId)?.displayName ?? "their";
      showToast({ label: `Updated ${name}'s avatar` });
    } catch {
      showToast({ label: "Couldn't use that photo as an avatar." });
    }
  }

  function selectAndReveal(id: string) {
    setSelectedId(id);
    setMobileTab("tree");
    reveal(id);
  }

  // Pans so the card is centred. Runs a frame later because the card
  // may have been added (or the tree tab shown) in this same update.
  function reveal(id: string, onlyIfHidden = false) {
    requestAnimationFrame(() => {
      const el = canvasRef.current;
      const node = el?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
      if (!el || !node) return;
      const c = el.getBoundingClientRect();
      if (c.width === 0) return;
      const n = node.getBoundingClientRect();
      const m = 24;
      const visible =
        n.left >= c.left + m && n.right <= c.right - m && n.top >= c.top + m && n.bottom <= c.bottom - m;
      if (onlyIfHidden && visible) return;
      const dx = c.left + c.width / 2 - (n.left + n.width / 2);
      const dy = c.top + c.height / 2 - (n.top + n.height / 2);
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    });
  }

  // --- Export / import ---------------------------------------------------

  function exportTree() {
    const json = serializeTree({ people, relationships, egoId, layout: manualPos });
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFileName();
    a.click();
    URL.revokeObjectURL(url);
  }

  async function pickImport(input: HTMLInputElement) {
    const file = input.files?.[0];
    // Reset so picking the same file again still fires onChange.
    input.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      showToast({ label: "That file is too large to be a tree export." });
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      showToast({ label: "That file couldn't be read." });
      return;
    }
    const result = parseTreeFile(text);
    if (!result.ok) {
      showToast({ label: result.error });
      return;
    }
    if (people.length === 0) applyImport(result.data, file.name);
    else setPendingImport({ file: result.data, name: file.name });
  }

  function applyImport(file: TreeFile, name: string) {
    const before = snapshot();
    const beforeLayout = manualPos;
    // Pending suggestions point at ids from the old tree, so they go too.
    commit({ people: file.people, relationships: file.relationships, egoId: file.egoId, proposals: [], resolvedRefs: {} }, null);
    setManualPos(file.layout);
    setSelectedId(null);
    setQuickAdd(null);
    setSameAs({});
    setUnchecked(new Set());
    setPendingImport(null);
    setRefit((n) => n + 1);
    const count = `${file.people.length} ${file.people.length === 1 ? "person" : "people"}`;
    setMessages((m) => [...m, { id: uid(), role: "assistant", tone: "muted", text: `Loaded ${count} from ${name}.` }]);
    showToast({
      label: `Imported ${count}`,
      onUndo: () => {
        commit(before, null);
        setManualPos(beforeLayout);
      },
    });
  }

  function resetTree() {
    const before = snapshot();
    const beforeLayout = manualPos;
    const beforeMessages = messages;
    const beforeModelNote = modelNote;
    const beforePhotos = photos;
    commit({ people: [], relationships: [], egoId: null, proposals: [], resolvedRefs: {} }, null);
    setPhotos([]);
    setShowPhotos(false);
    setViewPhotoId(null);
    setSlideshowIds(null);
    setManualPos({});
    setMessages([{ id: uid(), role: "assistant", text: FRESH_WELCOME }]);
    setModelNote(null);
    setSelectedId(null);
    setQuickAdd(null);
    setSameAs({});
    setUnchecked(new Set());
    setConfirmReset(false);
    setInput("");
    setRefit((n) => n + 1);
    setMobileTab("chat");
    showToast({
      label: "Tree reset",
      onUndo: () => {
        commit(before, null);
        setPhotos(beforePhotos);
        setManualPos(beforeLayout);
        setMessages(beforeMessages);
        setModelNote(beforeModelNote);
        setRefit((n) => n + 1);
      },
    });
  }

  // --- Layout ------------------------------------------------------------

  const autoPositioned = useMemo(() => layoutTree(allPeople, allRels, SIZE), [allPeople, allRels]);
  // Dragged people sit where they were dropped. Auto-placed people
  // (including new ghosts) slide right until they stop overlapping
  // a dragged one, so nobody ends up hidden underneath another card.
  const placed = useMemo(() => {
    const overlaps = (a: Point, b: Point) =>
      Math.abs(a.x - b.x) < SIZE.nodeW + 8 && Math.abs(a.y - b.y) < SIZE.nodeH + 8;
    const fixed = autoPositioned
      .filter((p) => manualPos[p.id])
      .map((p) => ({ ...p, ...manualPos[p.id] }));
    const out = [...fixed];
    for (const p of autoPositioned) {
      if (manualPos[p.id]) continue;
      let x = p.x;
      while (fixed.some((f) => overlaps(f, { x, y: p.y }))) x += SIZE.nodeW + SIZE.hGap;
      out.push({ ...p, x });
    }
    return out;
  }, [autoPositioned, manualPos]);
  const positioned = useMemo(
    () => (drag?.moved ? placed.map((p) => (p.id === drag.id ? { ...p, ...drag.at } : p)) : placed),
    [placed, drag]
  );
  const hasManualLayout = people.some((p) => manualPos[p.id]);

  function onNodePointerDown(e: React.PointerEvent<HTMLButtonElement>, p: Point & { id: string }) {
    suppressClick.current = false;
    if (e.button !== 0 || preview.pendingIds.has(p.id)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      id: p.id,
      startX: e.clientX,
      startY: e.clientY,
      origin: { x: p.x, y: p.y },
      at: { x: p.x, y: p.y },
      moved: false,
    };
  }

  function onNodePointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    // A few pixels of jitter is still a click, not a drag.
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    const snap = (v: number) => Math.max(0, Math.round(v / SNAP) * SNAP);
    const next = {
      ...d,
      moved: true,
      at: { x: snap(d.origin.x + dx / zoom), y: snap(d.origin.y + dy / zoom) },
    };
    dragRef.current = next;
    setDrag(next);
  }

  function onNodePointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    onNodePointerMove(e);
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d?.moved) return;
    setManualPos((prev) => ({ ...prev, [d.id]: d.at }));
    suppressClick.current = true;
  }

  function onNodePointerCancel() {
    dragRef.current = null;
    setDrag(null);
  }

  // Dragging empty space (or a review-pending card, which can't be
  // moved) pans the whole tree. Real cards keep their own drag.
  function onCanvasPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || panRef.current) return;
    const target = e.target as Element;
    if (target.closest(".pt-node:not(.pending)")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    panRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origin: { x: view.x, y: view.y },
      moved: false,
      onBackground: !target.closest(".pt-node"),
    };
  }

  function onCanvasPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const p = panRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    const dx = e.clientX - p.startX;
    const dy = e.clientY - p.startY;
    if (!p.moved && Math.hypot(dx, dy) < 4) return;
    if (!p.moved) setPanning(true);
    p.moved = true;
    setView((v) => ({ ...v, x: p.origin.x + dx, y: p.origin.y + dy }));
  }

  function onCanvasPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const p = panRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    // Pointer capture retargets the click to the canvas, so a plain
    // click on empty space clears the selection here instead.
    if (!p.moved && p.onBackground && e.type === "pointerup") setSelectedId(null);
    panRef.current = null;
    setPanning(false);
  }

  // Focusing a card (e.g. with Tab) makes the browser scroll the
  // clipped canvas; fold that scroll into the pan instead.
  function onCanvasScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const { scrollLeft: sx, scrollTop: sy } = el;
    if (!sx && !sy) return;
    el.scrollLeft = 0;
    el.scrollTop = 0;
    setView((v) => ({ ...v, x: v.x - sx, y: v.y - sy }));
  }

  function zoomAt(next: (z: number) => number, anchor?: Point) {
    const el = canvasRef.current;
    const a = anchor ?? { x: (el?.clientWidth ?? 0) / 2, y: (el?.clientHeight ?? 0) / 2 };
    setView((v) => {
      const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next(v.zoom)));
      const k = z / v.zoom;
      return { zoom: z, x: a.x - (a.x - v.x) * k, y: a.y - (a.y - v.y) * k };
    });
  }

  // Arrows move focus between people: up to a parent, down to a child,
  // left/right along the same row. Alt+arrows nudge the card instead.
  function onNodeKeyDown(e: React.KeyboardEvent, p: (typeof positioned)[number]) {
    if (!e.key.startsWith("Arrow") || e.ctrlKey || e.metaKey) return;
    // Otherwise the scroll container eats the arrow and pans the canvas.
    e.preventDefault();
    if (e.altKey) {
      nudge(e, p);
      return;
    }
    const target = neighbourOf(p, e.key);
    if (target) {
      canvasRef.current
        ?.querySelector<HTMLElement>(`[data-id="${CSS.escape(target)}"]`)
        ?.focus({ preventScroll: true });
      reveal(target, true);
    }
  }

  function neighbourOf(p: (typeof positioned)[number], key: string): string | null {
    const candidates = positioned.filter((c) => c.id !== p.id && !preview.pendingIds.has(c.id));
    const closestByX = (list: typeof candidates) =>
      list.reduce<(typeof candidates)[number] | null>(
        (best, c) => (!best || Math.abs(c.x - p.x) < Math.abs(best.x - p.x) ? c : best),
        null
      )?.id ?? null;
    if (key === "ArrowUp" || key === "ArrowDown") {
      const related = new Set(
        (key === "ArrowUp" ? getParents : getChildren)(p.id, allPeople, allRels).map((r) => r.id)
      );
      return closestByX(candidates.filter((c) => related.has(c.id)));
    }
    const dir = key === "ArrowRight" ? 1 : -1;
    return closestByX(
      candidates.filter((c) => Math.abs(c.y - p.y) < SIZE.nodeH && (c.x - p.x) * dir > 0)
    );
  }

  function nudge(e: React.KeyboardEvent, p: Point & { id: string }) {
    const step = e.shiftKey ? SNAP * 5 : SNAP;
    const delta: Record<string, Point> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const d = delta[e.key];
    if (!d || preview.pendingIds.has(p.id)) return;
    setManualPos((prev) => ({ ...prev, [p.id]: { x: Math.max(0, p.x + d.x), y: Math.max(0, p.y + d.y) } }));
  }

  function resetLayout() {
    const before = manualPos;
    setManualPos({});
    showToast({ label: "Layout reset", onUndo: () => setManualPos(before) });
  }
  const connectors = useMemo(
    () => familyConnectors(positioned, allRels, SIZE, new Set(preview.pendingRels.map((r) => r.id))),
    [positioned, allRels, preview.pendingRels]
  );
  const width = (positioned.length ? Math.max(...positioned.map((p) => p.x)) + SIZE.nodeW : 0) + PAD * 2;
  const height = (positioned.length ? Math.max(...positioned.map((p) => p.y)) + SIZE.nodeH : 0) + PAD * 2;
  const hoverNode = hoverId ? preview.proposalByNode.get(hoverId) ?? null : null;

  function centerAt(z: number) {
    const el = canvasRef.current;
    if (!el) return;
    setView({ zoom: z, x: (el.clientWidth - width * z) / 2, y: (el.clientHeight - height * z) / 2 });
  }

  function fit() {
    const el = canvasRef.current;
    if (!el || !positioned.length) return;
    const scale = Math.min((el.clientWidth - 16) / width, (el.clientHeight - 16) / height);
    centerAt(Math.max(MIN_ZOOM, Math.min(1.25, Math.round(scale * 20) / 20)));
  }

  const hasTree = positioned.length > 0;
  const fittedOnce = useRef(false);
  useEffect(() => {
    if (!loaded || fittedOnce.current || !hasTree) return;
    const el = canvasRef.current;
    // On mobile the tree tab may be hidden; wait until it has a size.
    if (!el || el.clientWidth === 0) return;
    fittedOnce.current = true;
    if (width > el.clientWidth || height > el.clientHeight) fit();
    else centerAt(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, hasTree, mobileTab]);

  // Wheel pans; Ctrl/Cmd+wheel (and trackpad pinch) zooms around the
  // cursor. React's onWheel is passive, so preventDefault needs this.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        zoomAt((z) => z * Math.exp(-e.deltaY * unit * 0.002), { x: e.clientX - r.left, y: e.clientY - r.top });
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX * unit, y: v.y - e.deltaY * unit }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [hasTree]);

  // Runs after the imported tree has rendered, so fit() sees its size.
  useEffect(() => {
    if (refit) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refit]);

  // Ghost nodes often land outside the visible area; bring the first
  // one into view when a new batch arrives.
  const pendingKey = [...preview.pendingIds].join("|");
  useEffect(() => {
    const first = [...preview.pendingIds][0];
    if (first) reveal(first, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  const status = modelStatus(modelNote, modelConfig);

  const batches = useMemo(() => {
    const ids: string[] = [];
    for (const p of proposals) if (!ids.includes(batchOf(p))) ids.push(batchOf(p));
    return ids;
  }, [proposals]);
  const anchoredBatches = new Set(messages.map((m) => m.batchId).filter(Boolean));

  // --- Render --------------------------------------------------------------

  function renderBatch(batchId: string) {
    const items = proposals.filter((p) => batchOf(p) === batchId);
    if (!items.length) return null;
    const count = items.filter(isChecked).length;
    return (
      <div className="pt-review" key={`batch-${batchId}`}>
        <div className="pt-review-head">
          <strong>Check before adding</strong>
          <span>Dashed cards in the tree show where they&apos;ll go.</span>
        </div>
        <ul>
          {items.map((p) => {
            const checked = isChecked(p);
            const lockedOff = !unchecked.has(p.id) && !checked;
            const match = sameNamePerson(p, people);
            const node = preview.proposalByNode.get(p.id);
            const label = p.isSpeaker ? "You" : node ? relationLabel(viewEgo, node, allPeople, allRels) : null;
            const existing = p.kind === "person" && p.tempId ? people.find((x) => x.id === p.tempId) : undefined;
            return (
              <li
                key={p.id}
                className={`pt-review-row ${p.kind} ${checked ? "" : "off"}`}
                onMouseEnter={() => setHoverId(p.id)}
                onMouseLeave={() => setHoverId(null)}
              >
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={lockedOff}
                    onChange={() => toggle(p)}
                  />
                  {p.kind === "person" ? (
                    <span className="pt-review-body">
                      <span className="pt-ghost-avatar">{initials(p.displayName ?? existing?.displayName ?? "?")}</span>
                      <span>
                        <span className="pt-review-title">
                          {existing ? `Update ${existing.displayName}` : p.displayName}
                          {label && <span className="pt-tag">{label}</span>}
                        </span>
                        <span className="pt-review-meta">
                          {personMeta({
                            birthYear: p.birthYear ?? null,
                            birthDate: p.birthDate ?? null,
                            birthPlace: p.birthPlace ?? null,
                          }) ||
                            (existing ? "No new details" : "New person")}
                        </span>
                      </span>
                    </span>
                  ) : (
                    <span className="pt-review-body pt-review-link">
                      {describeProposal(p, people, proposals, resolvedRefs)}
                      {lockedOff && <span className="pt-review-meta"> — needs the person above</span>}
                    </span>
                  )}
                </label>
                {p.confidence !== "high" && (
                  <span className={`pt-conf ${p.confidence}`} title={p.reason}>
                    {p.confidence === "low" ? "Unsure" : "Likely"}
                  </span>
                )}
                <span className="pt-why" title={`Why: ${p.reason}`} aria-label={`Why: ${p.reason}`}>
                  ?
                </span>
                {match && checked && (
                  <div className="pt-same-name">
                    <span>{match.displayName} is already in your tree.</span>
                    <select
                      value={sameAs[p.id] ?? ""}
                      onChange={(e) =>
                        setSameAs((prev) => {
                          const next = { ...prev };
                          if (e.target.value) next[p.id] = e.target.value;
                          else delete next[p.id];
                          return next;
                        })
                      }
                    >
                      <option value="">Add as a different person</option>
                      <option value={match.id}>
                        Same person as {match.displayName}
                        {personMeta(match) ? ` (${personMeta(match)})` : ""}
                      </option>
                    </select>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <div className="pt-review-actions">
          <button className="pt-btn pt-btn-primary" disabled={count === 0} onClick={() => acceptBatch(batchId)}>
            {count === items.length ? "Add all to tree" : `Add ${count} selected`}
          </button>
          <button className="pt-btn pt-btn-ghost" onClick={() => discardBatch(batchId)}>
            Discard
          </button>
        </div>
      </div>
    );
  }

  function renderNode(p: (typeof positioned)[number]) {
    const pending = preview.pendingIds.has(p.id);
    const label = relationLabel(viewEgo, p.id, allPeople, allRels);
    const showPreferred = !!p.preferredName && p.preferredName !== p.displayName;
    const nodeName = showPreferred ? `${p.displayName} (${p.preferredName})` : p.displayName;
    const classes = [
      "pt-node",
      pending && "pending",
      preview.updatingIds.has(p.id) && "updating",
      selectedId === p.id && "selected",
      hoverNode === p.id && "hl",
      recentIds.has(p.id) && "recent",
      label === "You" && "ego",
      drag?.moved && drag.id === p.id && "dragging",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <button
        key={p.id}
        data-id={p.id}
        type="button"
        className={classes}
        style={{ left: p.x + PAD, top: p.y + PAD, width: SIZE.nodeW, height: SIZE.nodeH }}
        onPointerDown={(e) => onNodePointerDown(e, p)}
        onPointerMove={onNodePointerMove}
        onPointerUp={onNodePointerUp}
        onPointerCancel={onNodePointerCancel}
        onKeyDown={(e) => onNodeKeyDown(e, p)}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if (!pending) setSelectedId(p.id === selectedId ? null : p.id);
        }}
        title={
          pending
            ? `${nodeName} — waiting for your review in chat`
            : `${nodeName} — arrow keys move between people; drag or Alt+arrow keys to move this card`
        }
      >
        {p.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="pt-avatar" src={p.avatarUrl} alt="" />
        ) : (
          <span className="pt-avatar pt-initials">{initials(p.displayName)}</span>
        )}
        <span className="pt-node-text">
          <span className="pt-node-name">
            {p.displayName}
            {showPreferred && (
              <span className="pt-node-preferred"> ({p.preferredName})</span>
            )}
          </span>
          <span className="pt-node-meta">
            {[pending ? "New" : label, birthLabel(p) ? `b. ${birthLabel(p)}` : null].filter(Boolean).join(" · ")}
          </span>
        </span>
      </button>
    );
  }

  return (
    <div className="pt-app">
      <header className="pt-header">
        <div className="pt-brand">
          <span aria-hidden>🌱</span>
          <h1>Family Tree</h1>
        </div>
        <span className="pt-pill" title={status.title}>
          <span className={`pt-dot ${status.tone}`} />
          {status.label}
        </span>
        <span className="pt-saved">Saved in this browser</span>
        <div className="pt-header-actions">
          <button
            className="pt-btn pt-btn-ghost pt-btn-icon"
            onClick={exportTree}
            disabled={people.length === 0}
            title="Download your tree as a file you can import later"
          >
            <DownloadIcon />
            Export
          </button>
          <button
            className="pt-btn pt-btn-ghost pt-btn-icon"
            onClick={() => importInputRef.current?.click()}
            title="Load a tree from an exported file"
          >
            <UploadIcon />
            Import
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => void pickImport(e.currentTarget)}
          />
          <button
            className="pt-btn pt-btn-ghost pt-btn-icon"
            onClick={() => setConfirmReset(true)}
            disabled={loading || (people.length === 0 && proposals.length === 0 && photos.length === 0)}
            title="Clear everyone and start a new tree"
          >
            <ResetIcon />
            Reset
          </button>
          <button className="pt-btn pt-btn-secondary pt-btn-icon" onClick={() => setShowPhotos(true)}>
            <PhotoIcon />
            Photos{photos.length ? ` (${photos.length})` : ""}
          </button>
          <button className="pt-btn pt-btn-secondary pt-btn-icon" onClick={() => setShowAdd(true)}>
            <UserPlusIcon />
            Person
          </button>
        </div>
        <div className="pt-tabs" role="tablist">
          <button role="tab" aria-selected={mobileTab === "chat"} onClick={() => setMobileTab("chat")}>
            Chat{proposals.length ? ` (${batches.length})` : ""}
          </button>
          <button role="tab" aria-selected={mobileTab === "tree"} onClick={() => setMobileTab("tree")}>
            Tree
          </button>
        </div>
      </header>

      <main className={`pt-main show-${mobileTab}`}>
        <section className="pt-chat" aria-label="Chat">
          <div className="pt-messages">
            {messages.map((m) => (
              <div key={m.id} className="pt-msg-group">
                <div className={`pt-msg ${m.role} ${m.tone ?? ""}`}>{m.text}</div>
                {m.debug && <DebugInfo debug={m.debug} />}
                {m.batchId && renderBatch(m.batchId)}
              </div>
            ))}
            {batches.filter((b) => !anchoredBatches.has(b)).map(renderBatch)}
            {loading && (
              <div className="pt-msg assistant pt-thinking">
                <span className="pt-typing" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
                Reading your message… {elapsed}s
                {elapsed >= 8 && <small>Local models can take up to a minute.</small>}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <form className="pt-composer" onSubmit={sendChat}>
            <div className="pt-chips">
              {suggestions.map((s) => (
                <button type="button" key={s} className="pt-chip" onClick={() => applySuggestion(s)}>
                  {s === EXAMPLE ? "Try an example" : `${s.trim()}…`}
                </button>
              ))}
            </div>
            <div className="pt-input-row">
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void sendChat();
                  }
                }}
                placeholder={people.length ? "Tell me about someone…" : "Start with your name…"}
                aria-label="Message"
              />
              {loading ? (
                <button type="button" className="pt-btn pt-btn-secondary" onClick={() => abortRef.current?.abort()}>
                  Stop
                </button>
              ) : (
                <button className="pt-btn pt-btn-primary" type="submit" disabled={!input.trim()}>
                  Send
                </button>
              )}
            </div>
            <small className="pt-hint">Enter to send · Shift+Enter for a new line</small>
          </form>
        </section>

        <section className="pt-tree" aria-label="Family tree">
          {positioned.length === 0 ? (
            <div className="pt-empty">
              <div className="pt-empty-card">
                <div className="pt-empty-icon" aria-hidden>
                  🌱
                </div>
                <h2>Your tree starts with you</h2>
                <p>Tell the chat who you are and who your parents are. You&apos;ll review everything before it&apos;s added.</p>
                <div className="pt-row">
                  <button
                    className="pt-btn pt-btn-orange"
                    onClick={() => {
                      setMobileTab("chat");
                      requestAnimationFrame(() => inputRef.current?.focus());
                    }}
                  >
                    Get Started
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div
              className={`pt-canvas ${panning ? "panning" : ""}`}
              ref={canvasRef}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
              onScroll={onCanvasScroll}
            >
              <div
                className="pt-stage"
                style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${zoom})` }}
              >
                <svg width={width} height={height} className="pt-lines">
                  <g transform={`translate(${PAD},${PAD})`}>
                    {connectors.map((c) => (
                      <path key={c.key} d={c.d} className={`pt-line ${c.kind} ${c.pending ? "pending" : ""}`} />
                    ))}
                  </g>
                </svg>
                {positioned.map(renderNode)}
              </div>
            </div>
          )}

          {positioned.length > 0 && (
            <>
              <div className="pt-zoom" role="group" aria-label="Zoom">
                <button onClick={() => zoomAt((z) => +(z - 0.1).toFixed(2))} aria-label="Zoom out">
                  −
                </button>
                <button onClick={() => zoomAt(() => 1)} title="Reset to 100%">
                  {Math.round(zoom * 100)}%
                </button>
                <button onClick={() => zoomAt((z) => +(z + 0.1).toFixed(2))} aria-label="Zoom in">
                  +
                </button>
                <button onClick={fit}>Fit</button>
                {hasManualLayout && (
                  <button onClick={resetLayout} title="Put everyone back in the automatic layout">
                    Tidy up
                  </button>
                )}
              </div>
              <div className="pt-legend">
                <span><i className="lg parent" /> Parent → child</span>
                <span><i className="lg spouse" /> Partners</span>
                {preview.pendingIds.size > 0 && (
                  <span><i className="lg pending" /> Waiting for review</span>
                )}
                <span>Drag cards to rearrange · drag empty space to pan</span>
              </div>
            </>
          )}

          {selected && (
            <PersonDrawer
              key={selected.id}
              person={selected}
              people={people}
              relationships={relationships}
              isEgo={selected.id === egoId}
              relation={relationLabel(egoId, selected.id, people, relationships)}
              quickAdd={quickAdd}
              setQuickAdd={setQuickAdd}
              onClose={() => setSelectedId(null)}
              onPatch={(patch) => patchPerson(selected.id, patch)}
              onAvatar={(f) => uploadAvatar(selected.id, f)}
              photos={photos.filter((p) => p.personIds.includes(selected.id))}
              photoBusy={photoBusy === selected.id}
              onAddPhotos={(files) => addPhotos(files, [selected.id])}
              onOpenPhoto={setViewPhotoId}
              onSelect={selectAndReveal}
              onAddRelative={(kind, name, coParentId) =>
                addRelative(selected.id, kind, { displayName: name }, coParentId)
              }
              onLinkRelative={(kind, id, coParentId) => linkRelative(selected.id, kind, id, coParentId)}
              egoId={egoId}
              onSetEgo={() => setEgoId(selected.id)}
              onDelete={() => deletePerson(selected.id)}
            />
          )}
        </section>
      </main>

      {showAdd && (
        <AddPersonDialog
          people={people}
          defaultAnchor={selectedId}
          onClose={() => setShowAdd(false)}
          onAdd={(fields, anchorId, kind) => {
            const id = addRelative(anchorId, kind, fields);
            setShowAdd(false);
            selectAndReveal(id);
          }}
        />
      )}

      {showPhotos && (
        <TreeGalleryDialog
          photos={photos}
          people={people}
          busy={photoBusy === "tree"}
          onAdd={(files) => addPhotos(files, [])}
          onOpen={setViewPhotoId}
          onPlay={setSlideshowIds}
          onClose={() => setShowPhotos(false)}
        />
      )}

      {viewingPhoto && (
        <PhotoViewer
          key={viewingPhoto.id}
          photo={viewingPhoto}
          people={people}
          onPatch={(patch) => updatePhoto(viewingPhoto.id, patch)}
          onSetAvatar={(personId) => setAvatarFromPhoto(viewingPhoto.id, personId)}
          onDelete={() => deletePhoto(viewingPhoto.id)}
          onClose={() => setViewPhotoId(null)}
        />
      )}

      {slideshowPhotos && (
        <Slideshow photos={slideshowPhotos} people={people} onClose={() => setSlideshowIds(null)} />
      )}

      {pendingImport && (
        <ImportConfirmDialog
          current={people.length}
          incoming={pendingImport.file.people.length}
          fileName={pendingImport.name}
          onCancel={() => setPendingImport(null)}
          onConfirm={() => applyImport(pendingImport.file, pendingImport.name)}
        />
      )}

      {confirmReset && (
        <ResetConfirmDialog
          current={people.length}
          photos={photos.length}
          onCancel={() => setConfirmReset(false)}
          onConfirm={resetTree}
        />
      )}

      {toast && (
        <div className="pt-toast" role="status">
          {toast.label}
          {toast.onUndo && (
            <button className="pt-toast-undo" onClick={undo}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PersonDrawer(props: {
  person: Person;
  people: Person[];
  relationships: Relationship[];
  isEgo: boolean;
  relation: string | null;
  quickAdd: QuickAdd | null;
  setQuickAdd: (q: QuickAdd | null) => void;
  onClose: () => void;
  onPatch: (patch: Partial<Person>) => void;
  onAvatar: (file: File | undefined) => void;
  photos: Photo[];
  photoBusy: boolean;
  onAddPhotos: (files: File[]) => void;
  onOpenPhoto: (id: string) => void;
  onSelect: (id: string) => void;
  onAddRelative: (kind: RelativeKind, name: string, coParentId: string | null) => void;
  onLinkRelative: (kind: RelativeKind, personId: string, coParentId: string | null) => void;
  egoId: string | null;
  onSetEgo: () => void;
  onDelete: () => void;
}) {
  const { person, people, relationships, quickAdd, setQuickAdd } = props;
  const groups: { kind: RelativeKind; title: string; list: Person[] }[] = [
    { kind: "parent", title: "Parents", list: getParents(person.id, people, relationships) },
    { kind: "partner", title: "Partners", list: getSpouses(person.id, people, relationships) },
    { kind: "child", title: "Children", list: getChildren(person.id, people, relationships) },
    { kind: "sibling", title: "Siblings", list: getSiblings(person.id, people, relationships) },
  ];
  const partners = groups[1].list;
  const soloPartner = partners.length === 1 ? partners[0] : null;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [listOpen, setListOpen] = useState(true);

  const coParentId = quickAdd?.kind === "child" && quickAdd.withPartner && soloPartner ? soloPartner.id : null;
  const quickKind = quickAdd?.kind;
  const quickName = quickAdd?.name;
  const candidates = useMemo(
    () => (quickKind ? relativeCandidates(quickKind, person.id, people, relationships, coParentId) : []),
    [quickKind, coParentId, person.id, people, relationships]
  );
  const matches = useMemo(
    () => (quickName !== undefined ? matchPeople(quickName, candidates, relationships) : []),
    [quickName, candidates, relationships]
  );
  const showList = listOpen && !!quickAdd?.name.trim();
  // Rows are the matches followed by the "Add new" row.
  const rowCount = matches.length + 1;

  function setName(name: string) {
    if (!quickAdd) return;
    setQuickAdd({ ...quickAdd, name });
    setActiveIndex(-1);
    setListOpen(true);
  }

  function pick(index: number) {
    if (!quickAdd) return;
    const match = matches[index];
    if (match) props.onLinkRelative(quickAdd.kind, match.id, coParentId);
    else if (quickAdd.name.trim()) props.onAddRelative(quickAdd.kind, quickAdd.name.trim(), coParentId);
    else return;
    setQuickAdd({ ...quickAdd, name: "" });
    setActiveIndex(-1);
  }

  function submitQuickAdd(e: React.FormEvent) {
    e.preventDefault();
    pick(showList ? activeIndex : -1);
  }

  function onQuickAddKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape" && showList) {
      e.stopPropagation();
      setListOpen(false);
      setActiveIndex(-1);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!quickAdd?.name.trim()) return;
      e.preventDefault();
      setListOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((i) => (i < 0 && step < 0 ? rowCount - 1 : (i + step + rowCount) % rowCount));
    }
  }

  return (
    <aside className="pt-drawer" aria-label={`Details for ${person.displayName}`}>
      <div className="pt-drawer-head">
        <label className="pt-drawer-avatar" title="Change photo">
          {person.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={person.avatarUrl} alt="" />
          ) : (
            <span>{initials(person.displayName)}</span>
          )}
          <span className="pt-drawer-avatar-edit">Photo</span>
          <input type="file" accept="image/*" hidden onChange={(e) => props.onAvatar(e.target.files?.[0])} />
        </label>
        <div>
          <h2>{person.displayName}</h2>
          {props.relation && <span className="pt-tag">{props.relation}</span>}
        </div>
        <button className="pt-icon-btn" onClick={props.onClose} aria-label="Close details">
          ×
        </button>
      </div>

      <div className="pt-drawer-body">
        <div className="pt-fields">
          <label className="wide">
            Full name
            <input value={person.displayName} onChange={(e) => props.onPatch({ displayName: e.target.value })} />
          </label>
          <label className="wide">
            Also known as
            <input
              value={person.preferredName ?? ""}
              placeholder="Nickname"
              onChange={(e) => props.onPatch({ preferredName: e.target.value || null })}
            />
          </label>
          <label>
            Birth date
            <input
              type="date"
              value={person.birthDate ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                props.onPatch(v ? { birthDate: v, birthYear: yearOf(v) } : { birthDate: null });
              }}
            />
          </label>
          <label>
            Birth year
            <input
              inputMode="numeric"
              value={person.birthYear ?? ""}
              placeholder="1960"
              readOnly={!!person.birthDate}
              title={person.birthDate ? "Set by the birth date — clear it to edit the year alone" : undefined}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "").slice(0, 4);
                props.onPatch({ birthYear: v ? Number(v) : null });
              }}
            />
          </label>
          <label>
            Gender
            <select
              value={person.gender ?? ""}
              onChange={(e) => props.onPatch({ gender: (e.target.value || null) as Gender | null })}
            >
              <option value="">Not set</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
          </label>
          <label>
            Birthplace
            <input
              value={person.birthPlace ?? ""}
              placeholder="Hanoi"
              onChange={(e) => props.onPatch({ birthPlace: e.target.value || null })}
            />
          </label>
          <label className="wide">
            Story
            <textarea
              value={person.bio ?? ""}
              placeholder="A memory, a favourite dish, a saying they had…"
              onChange={(e) => props.onPatch({ bio: e.target.value || null })}
            />
          </label>
        </div>
        <small className="pt-hint">Changes save automatically.</small>

        <h3>Photos</h3>
        <PhotoGrid
          photos={props.photos}
          people={people}
          busy={props.photoBusy}
          onAdd={props.onAddPhotos}
          onOpen={props.onOpenPhoto}
        />

        <h3>Family</h3>
        {groups.map((g) => (
          <div key={g.kind} className="pt-family-group">
            <div className="pt-family-head">
              <span>{g.title}</span>
              <button
                className="pt-link"
                onClick={() => setQuickAdd({ kind: g.kind, name: "", withPartner: true })}
              >
                + Add
              </button>
            </div>
            <div className="pt-chips">
              {g.list.length === 0 && <span className="pt-none">None yet</span>}
              {g.list.map((r) => (
                <button key={r.id} className="pt-chip person" onClick={() => props.onSelect(r.id)}>
                  {r.displayName}
                </button>
              ))}
            </div>
            {quickAdd?.kind === g.kind && (
              <form className="pt-quick-add" onSubmit={submitQuickAdd}>
                <div className="pt-combo">
                  <input
                    autoFocus
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={showList}
                    aria-controls={`pt-suggest-${g.kind}`}
                    aria-activedescendant={showList && activeIndex >= 0 ? `pt-suggest-${g.kind}-${activeIndex}` : undefined}
                    value={quickAdd.name}
                    placeholder={`${KIND_LABEL[g.kind]}'s name`}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={onQuickAddKey}
                    onFocus={() => setListOpen(true)}
                    onBlur={() => setListOpen(false)}
                  />
                  {showList && (
                    <ul className="pt-suggest" role="listbox" id={`pt-suggest-${g.kind}`}>
                      {matches.map((m, i) => {
                        const meta = [relationLabel(props.egoId, m.id, people, relationships), personMeta(m)]
                          .filter(Boolean)
                          .join(" · ");
                        return (
                          <li
                            key={m.id}
                            id={`pt-suggest-${g.kind}-${i}`}
                            role="option"
                            aria-selected={i === activeIndex}
                            onMouseDown={(e) => e.preventDefault()}
                            onMouseEnter={() => setActiveIndex(i)}
                            onClick={() => pick(i)}
                          >
                            <strong>{m.displayName}</strong>
                            {meta && <small>{meta}</small>}
                          </li>
                        );
                      })}
                      <li
                        id={`pt-suggest-${g.kind}-${matches.length}`}
                        role="option"
                        className="pt-suggest-new"
                        aria-selected={activeIndex === matches.length}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setActiveIndex(matches.length)}
                        onClick={() => pick(matches.length)}
                      >
                        Add new &ldquo;{quickAdd.name.trim()}&rdquo;
                      </li>
                    </ul>
                  )}
                </div>
                <button className="pt-btn pt-btn-primary pt-btn-small" disabled={!quickAdd.name.trim()}>
                  Add
                </button>
                {g.kind === "child" && soloPartner && (
                  <label className="pt-check">
                    <input
                      type="checkbox"
                      checked={quickAdd.withPartner}
                      onChange={(e) => setQuickAdd({ ...quickAdd, withPartner: e.target.checked })}
                    />
                    Also {soloPartner.displayName}&apos;s child
                  </label>
                )}
              </form>
            )}
          </div>
        ))}
      </div>

      <div className="pt-drawer-foot">
        {!props.isEgo && (
          <button className="pt-btn pt-btn-ghost" onClick={props.onSetEgo} title="Relationship labels are shown relative to this person">
            This is me
          </button>
        )}
        {confirmDelete ? (
          <span className="pt-confirm">
            Delete and unlink?
            <button className="pt-btn pt-btn-danger pt-btn-small" onClick={props.onDelete}>
              Delete
            </button>
            <button className="pt-btn pt-btn-ghost pt-btn-small" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button className="pt-btn pt-btn-ghost danger" onClick={() => setConfirmDelete(true)}>
            Delete person
          </button>
        )}
      </div>
    </aside>
  );
}

function ImportConfirmDialog(props: {
  current: number;
  incoming: number;
  fileName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const plural = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
  return (
    <div className="pt-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div className="pt-dialog" role="dialog" aria-label="Replace your tree">
        <h2>Replace your tree?</h2>
        <p>
          Your tree of {plural(props.current)} will be replaced by {plural(props.incoming)} from{" "}
          <strong>{props.fileName}</strong>. Pending suggestions in the chat will be cleared. You can undo right after.
        </p>
        <div className="pt-row end">
          <button type="button" className="pt-btn pt-btn-ghost" autoFocus onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="pt-btn pt-btn-danger" onClick={props.onConfirm}>
            Replace
          </button>
        </div>
      </div>
    </div>
  );
}

function ResetConfirmDialog(props: { current: number; photos: number; onCancel: () => void; onConfirm: () => void }) {
  const plural = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
  const photoNote = props.photos ? `, ${props.photos === 1 ? "1 photo" : `${props.photos} photos`}` : "";
  return (
    <div className="pt-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div className="pt-dialog" role="dialog" aria-label="Reset your tree">
        <h2>Reset your tree?</h2>
        <p>
          All {plural(props.current)}, their links{photoNote}, your layout, pending suggestions and the chat history will be
          cleared. You can undo right after — or Export first to keep a copy.
        </p>
        <div className="pt-row end">
          <button type="button" className="pt-btn pt-btn-ghost" autoFocus onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="pt-btn pt-btn-danger" onClick={props.onConfirm}>
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}

function AddPersonDialog(props: {
  people: Person[];
  defaultAnchor: string | null;
  onClose: () => void;
  onAdd: (
    fields: Pick<Person, "displayName" | "birthYear" | "birthDate" | "birthPlace">,
    anchorId: string | null,
    kind: RelativeKind
  ) => void;
}) {
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [year, setYear] = useState("");
  const [place, setPlace] = useState("");
  const [anchor, setAnchor] = useState(props.defaultAnchor ?? "");
  const [kind, setKind] = useState<RelativeKind>("parent");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    props.onAdd(
      {
        displayName: name.trim(),
        birthYear: year ? Number(year) : null,
        birthDate: date || null,
        birthPlace: place.trim() || null,
      },
      anchor || null,
      kind
    );
  }

  return (
    <div className="pt-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <form className="pt-dialog" onSubmit={submit} role="dialog" aria-label="Add a person">
        <h2>Add a person</h2>
        <div className="pt-fields">
          <label className="wide">
            Full name
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nguyen Van Minh" />
          </label>
          <label>
            Birth date
            <input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                if (e.target.value) setYear(String(yearOf(e.target.value) ?? ""));
              }}
            />
          </label>
          <label>
            Birth year
            <input
              inputMode="numeric"
              value={year}
              readOnly={!!date}
              onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="Optional"
            />
          </label>
          <label className="wide">
            Birthplace
            <input value={place} onChange={(e) => setPlace(e.target.value)} placeholder="Optional" />
          </label>
          {props.people.length > 0 && (
            <>
              <label>
                Related to
                <select value={anchor} onChange={(e) => setAnchor(e.target.value)}>
                  <option value="">Nobody yet</option>
                  {props.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                As their
                <select value={kind} disabled={!anchor} onChange={(e) => setKind(e.target.value as RelativeKind)}>
                  {(Object.keys(KIND_LABEL) as RelativeKind[]).map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k].toLowerCase()}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>
        <div className="pt-row end">
          <button type="button" className="pt-btn pt-btn-ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button className="pt-btn pt-btn-primary" disabled={!name.trim()}>
            Add to tree
          </button>
        </div>
      </form>
    </div>
  );
}

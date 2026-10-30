"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Person, Photo } from "@/lib/types";
import { getPhotoBlob, type PhotoVariant } from "@/lib/photo-store";
import { slideCaption, stepIndex } from "@/lib/slideshow";
import { ChevronLeftIcon, ChevronRightIcon, FullscreenIcon, PauseIcon, PlayIcon } from "./icons";

const SLIDE_MS = 5000;

export function usePhotoUrl(id: string, variant: PhotoVariant): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    setUrl(null);
    getPhotoBlob(id, variant)
      .then((blob) => {
        if (!live || !blob) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => {});
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id, variant]);
  return url;
}

function taggedNames(photo: Photo, people: Person[]): string {
  return people
    .filter((p) => photo.personIds.includes(p.id))
    .map((p) => p.displayName)
    .join(", ");
}

function PhotoThumb(props: { photo: Photo; people: Person[]; onOpen: () => void }) {
  const { photo } = props;
  const url = usePhotoUrl(photo.id, "thumb");
  const title = [photo.caption, photo.takenYear, taggedNames(photo, props.people)].filter(Boolean).join(" · ");
  return (
    <button type="button" className="pt-photo-thumb" onClick={props.onOpen} title={title || "Open photo"}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url && <img src={url} alt={photo.caption ?? ""} />}
    </button>
  );
}

export function PhotoGrid(props: {
  photos: Photo[];
  people: Person[];
  busy: boolean;
  onAdd: (files: File[]) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="pt-photo-grid">
      {props.photos.map((p) => (
        <PhotoThumb key={p.id} photo={p} people={props.people} onOpen={() => props.onOpen(p.id)} />
      ))}
      <label className={`pt-photo-add ${props.busy ? "busy" : ""}`}>
        {props.busy ? "Adding…" : "+ Add photos"}
        <input
          type="file"
          accept="image/*"
          multiple
          hidden
          disabled={props.busy}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) props.onAdd(files);
          }}
        />
      </label>
    </div>
  );
}

export function TreeGalleryDialog(props: {
  photos: Photo[];
  people: Person[];
  busy: boolean;
  onAdd: (files: File[]) => void;
  onOpen: (id: string) => void;
  onPlay: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<"all" | "untagged">("all");
  const untagged = useMemo(() => {
    const live = new Set(props.people.map((p) => p.id));
    return props.photos.filter((ph) => !ph.personIds.some((id) => live.has(id)));
  }, [props.photos, props.people]);
  const shown = filter === "all" ? props.photos : untagged;

  return (
    <div className="pt-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="pt-dialog pt-dialog-wide" role="dialog" aria-label="Family photos">
        <div className="pt-dialog-head">
          <h2>Family photos</h2>
          <div className="pt-row">
            <button
              className="pt-btn pt-btn-secondary pt-btn-small pt-btn-icon"
              disabled={shown.length === 0}
              onClick={() => props.onPlay(shown.map((p) => p.id))}
            >
              <PlayIcon size={14} />
              Play slideshow
            </button>
            <button className="pt-icon-btn" onClick={props.onClose} aria-label="Close photos">
              ×
            </button>
          </div>
        </div>
        <div className="pt-chips">
          <button className="pt-chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            All ({props.photos.length})
          </button>
          <button className="pt-chip" aria-pressed={filter === "untagged"} onClick={() => setFilter("untagged")}>
            Not tagged ({untagged.length})
          </button>
        </div>
        <div className="pt-dialog-body">
          <PhotoGrid photos={shown} people={props.people} busy={props.busy} onAdd={props.onAdd} onOpen={props.onOpen} />
        </div>
        <small className="pt-hint">
          Photos added here belong to the whole family; tag people from the photo to show it on their page. Photos are
          stored in this browser only.
        </small>
      </div>
    </div>
  );
}

export function PhotoViewer(props: {
  photo: Photo;
  people: Person[];
  onPatch: (patch: Partial<Photo>) => void;
  onSetAvatar: (personId: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { photo } = props;
  const url = usePhotoUrl(photo.id, "full");
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const sorted = useMemo(
    () => [...props.people].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [props.people]
  );
  const q = query.trim().toLowerCase();
  const listed = q
    ? sorted.filter((p) => `${p.displayName} ${p.preferredName ?? ""}`.toLowerCase().includes(q))
    : sorted;

  function toggleTag(id: string, on: boolean) {
    props.onPatch({
      personIds: on ? [...photo.personIds, id] : photo.personIds.filter((x) => x !== id),
    });
  }

  return (
    <div className="pt-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="pt-dialog pt-dialog-wide" role="dialog" aria-label="Photo">
        <div className="pt-dialog-head">
          <h2>{photo.caption || "Photo"}</h2>
          <button className="pt-icon-btn" onClick={props.onClose} aria-label="Close photo">
            ×
          </button>
        </div>
        <div className="pt-photo-viewer">
          <div className="pt-photo-stage">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {url && <img src={url} alt={photo.caption ?? ""} width={photo.width} height={photo.height} />}
          </div>
          <div className="pt-photo-side">
            <div className="pt-fields">
              <label className="wide">
                Caption
                <textarea
                  value={photo.caption ?? ""}
                  placeholder="Tet 1995 at grandma's house"
                  onChange={(e) => props.onPatch({ caption: e.target.value || null })}
                />
              </label>
              <label>
                Year taken
                <input
                  inputMode="numeric"
                  value={photo.takenYear ?? ""}
                  placeholder="1995"
                  onChange={(e) => {
                    const v = e.target.value.replace(/\D/g, "").slice(0, 4);
                    props.onPatch({ takenYear: v ? Number(v) : null });
                  }}
                />
              </label>
            </div>
            <div>
              <div className="pt-family-head">
                <span>Who&apos;s in this photo</span>
              </div>
              {sorted.length > 8 && (
                <div className="pt-fields">
                  <label className="wide">
                    <input value={query} placeholder="Find a person" onChange={(e) => setQuery(e.target.value)} />
                  </label>
                </div>
              )}
              {sorted.length === 0 && <span className="pt-none">Add people to the tree to tag them.</span>}
              <ul className="pt-tag-list">
                {listed.map((p) => {
                  const on = photo.personIds.includes(p.id);
                  return (
                    <li key={p.id}>
                      <label className="pt-check">
                        <input type="checkbox" checked={on} onChange={(e) => toggleTag(p.id, e.target.checked)} />
                        {p.displayName}
                      </label>
                      {on && (
                        <button className="pt-link" onClick={() => props.onSetAvatar(p.id)}>
                          Use as avatar
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
        <div className="pt-row end">
          {confirmDelete ? (
            <span className="pt-confirm">
              Delete this photo for good?
              <button className="pt-btn pt-btn-danger pt-btn-small" onClick={props.onDelete}>
                Delete
              </button>
              <button className="pt-btn pt-btn-ghost pt-btn-small" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button className="pt-btn pt-btn-ghost danger" onClick={() => setConfirmDelete(true)}>
              Delete photo
            </button>
          )}
          <button className="pt-btn pt-btn-primary" onClick={props.onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// Keeps object URLs for the current and next slide, so advancing shows
// the next photo without waiting on IndexedDB.
function useSlideUrls(currentId: string | null, nextId: string | null): Map<string, string> {
  const cache = useRef(new Map<string, string>());
  const [, bump] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    const urls = cache.current;
    const want = [currentId, nextId].filter((id): id is string => Boolean(id));
    for (const [id, url] of urls) {
      if (!want.includes(id)) {
        URL.revokeObjectURL(url);
        urls.delete(id);
      }
    }
    let live = true;
    for (const id of want) {
      if (urls.has(id)) continue;
      getPhotoBlob(id, "full")
        .then((blob) => {
          if (!live || !blob || urls.has(id)) return;
          urls.set(id, URL.createObjectURL(blob));
          bump();
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [currentId, nextId]);

  useEffect(() => {
    const urls = cache.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  return cache.current;
}

export function Slideshow(props: { photos: Photo[]; people: Person[]; onClose: () => void }) {
  const { photos, onClose } = props;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);

  const n = photos.length;
  const at = Math.min(index, Math.max(n - 1, 0));
  const photo = photos[at] ?? null;
  const next = n > 1 ? photos[stepIndex(at, n, 1)] : null;
  const urls = useSlideUrls(photo?.id ?? null, next?.id ?? null);
  const url = photo ? urls.get(photo.id) ?? null : null;

  useEffect(() => {
    if (n === 0) onClose();
  }, [n, onClose]);

  useEffect(() => {
    if (!playing || !url || n < 2) return;
    const t = setTimeout(() => setIndex(stepIndex(at, n, 1)), SLIDE_MS);
    return () => clearTimeout(t);
  }, [at, n, playing, url]);

  useEffect(() => {
    rootRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight") setIndex((i) => stepIndex(Math.min(i, n - 1), n, 1));
      else if (e.key === "ArrowLeft") setIndex((i) => stepIndex(Math.min(i, n - 1), n, -1));
      else if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [n]);

  useEffect(
    () => () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    },
    []
  );

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else rootRef.current?.requestFullscreen?.().catch(() => {});
  }

  if (!photo) return null;
  const { caption, meta } = slideCaption(photo, props.people);

  return (
    <div ref={rootRef} className="pt-slideshow" role="dialog" aria-modal="true" aria-label="Slideshow" tabIndex={-1}>
      <div className="pt-slideshow-stage">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url && <img key={photo.id} src={url} alt={caption ?? ""} />}
        {(caption || meta) && (
          <div className="pt-slideshow-caption">
            {caption && <p>{caption}</p>}
            {meta && <small>{meta}</small>}
          </div>
        )}
      </div>
      <div className="pt-slideshow-bar">
        <span className="pt-slideshow-count">
          {at + 1} / {n}
        </span>
        <div className="pt-slideshow-controls">
          <button disabled={n < 2} onClick={() => setIndex(stepIndex(at, n, -1))} aria-label="Previous photo">
            <ChevronLeftIcon size={20} />
          </button>
          <button onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause slideshow" : "Play slideshow"}>
            {playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
          </button>
          <button disabled={n < 2} onClick={() => setIndex(stepIndex(at, n, 1))} aria-label="Next photo">
            <ChevronRightIcon size={20} />
          </button>
        </div>
        <div className="pt-slideshow-controls end">
          <button onClick={toggleFullscreen} aria-label="Toggle full screen">
            <FullscreenIcon size={18} />
          </button>
          <button onClick={onClose} aria-label="Close slideshow">
            ×
          </button>
        </div>
      </div>
    </div>
  );
}

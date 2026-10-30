import type { Person, Photo } from "./types";

export function stepIndex(i: number, n: number, dir: 1 | -1): number {
  if (n <= 0) return 0;
  return (((i + dir) % n) + n) % n;
}

export function slideCaption(photo: Photo, people: Person[]): { caption: string | null; meta: string | null } {
  const caption = photo.caption?.trim() || null;
  const names = people.filter((p) => photo.personIds.includes(p.id)).map((p) => p.displayName);
  const meta = [photo.takenYear ? String(photo.takenYear) : null, names.join(", ") || null].filter(Boolean).join(" · ");
  return { caption, meta: meta || null };
}

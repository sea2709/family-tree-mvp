import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { deletePhotoBlobs, getPhotoBlob, isQuotaError, putPhotoBlobs, requestPersistence } from "./photo-store";

describe("photo blobs in IndexedDB", () => {
  it("stores, reads and deletes both variants of a photo", async () => {
    await putPhotoBlobs("p1", { full: new Blob(["full"]), thumb: new Blob(["thumb"]) });
    expect(await (await getPhotoBlob("p1", "full"))?.text()).toBe("full");
    expect(await (await getPhotoBlob("p1", "thumb"))?.text()).toBe("thumb");

    await deletePhotoBlobs("p1");
    expect(await getPhotoBlob("p1", "full")).toBeNull();
    expect(await getPhotoBlob("p1", "thumb")).toBeNull();
  });

  it("returns null for a photo that was never stored", async () => {
    expect(await getPhotoBlob("missing", "full")).toBeNull();
  });
});

describe("isQuotaError", () => {
  it("only matches the browser's quota DOMException", () => {
    expect(isQuotaError(new DOMException("full", "QuotaExceededError"))).toBe(true);
    expect(isQuotaError(new DOMException("nope", "AbortError"))).toBe(false);
    expect(isQuotaError(new Error("QuotaExceededError"))).toBe(false);
  });
});

describe("requestPersistence", () => {
  it("asks the browser once and swallows a refusal", async () => {
    const persist = vi.fn(() => Promise.reject(new Error("denied")));
    vi.stubGlobal("navigator", { storage: { persist } });
    requestPersistence();
    requestPersistence();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

function loadImage(blob: Blob): Promise<{ img: HTMLImageElement; done: () => void }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, done: () => URL.revokeObjectURL(url) });
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function canvasOf(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  return { canvas, ctx };
}

// Avatars are stored as data URLs in localStorage, which caps out at a
// few MB; a phone photo would silently stop the tree from saving.
export async function shrinkImage(file: Blob, size = 160): Promise<string> {
  const { img, done } = await loadImage(file);
  try {
    const { canvas, ctx } = canvasOf(size, size);
    const side = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    done();
  }
}

// Phone photos are 3–8 MB; capping the long edge keeps a gallery of
// hundreds within the browser's storage quota.
export async function resizeImage(
  file: Blob,
  maxEdge: number
): Promise<{ blob: Blob; width: number; height: number }> {
  const { img, done } = await loadImage(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const width = Math.round(img.width * scale);
    const height = Math.round(img.height * scale);
    const { canvas, ctx } = canvasOf(width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) throw new Error("could not encode image");
    return { blob, width, height };
  } finally {
    done();
  }
}

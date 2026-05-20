
export const IMAGE_AUTO_RESIZE_TARGET_BYTES = Math.floor(3.5 * 1024 * 1024);
export const IMAGE_AUTO_RESIZE_SOURCE_LIMIT_BYTES = 100 * 1024 * 1024;

const QUALITY_STEPS = [0.85, 0.75, 0.65, 0.5] as const;
const MAX_FULL_RES_COMPRESSION_PIXELS = 20_000_000;

const RESIZABLE_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/bmp",
  "image/tiff",
]);

const RESIZABLE_IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "heic",
  "heif",
  "bmp",
  "tif",
  "tiff",
]);

export type ImageAttachmentResizeResult =
  | { status: "unchanged"; file: File }
  | { status: "resized"; file: File }
  | { status: "failed"; error: string };

interface LoadedBrowserImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

export function isAutoResizableImage(file: Pick<File, "name" | "type">): boolean {
  const mimeType = file.type.trim().toLowerCase();
  if (RESIZABLE_IMAGE_MIME_TYPES.has(mimeType)) {
    return true;
  }

  const extension = file.name.split(".").pop()?.trim().toLowerCase();
  return extension ? RESIZABLE_IMAGE_EXTENSIONS.has(extension) : false;
}

export function shouldAutoResizeImageAttachment(file: Pick<File, "name" | "size" | "type">): boolean {
  return isAutoResizableImage(file) && file.size > IMAGE_AUTO_RESIZE_TARGET_BYTES;
}

export function filenameForResizedImage(name: string): string {
  const fallback = "attachment";
  const trimmedName = name.trim() || fallback;
  if (/\.(?:jpe?g)$/i.test(trimmedName)) {
    return trimmedName;
  }

  const withoutExtension = trimmedName.replace(/\.[^./\\]+$/, "") || fallback;
  return `${withoutExtension}.jpg`;
}

export async function prepareImageAttachmentForUpload(
  file: File,
): Promise<ImageAttachmentResizeResult> {
  if (!shouldAutoResizeImageAttachment(file)) {
    return { status: "unchanged", file };
  }

  if (await isAnimatedWebp(file)) {
    return { status: "unchanged", file };
  }

  if (file.size > IMAGE_AUTO_RESIZE_SOURCE_LIMIT_BYTES) {
    return {
      status: "failed",
      error: "This image is too large to process safely. Please choose a smaller image.",
    };
  }

  let image: LoadedBrowserImage;
  try {
    image = await loadBrowserImage(file);
  } catch {
    return {
      status: "failed",
      error: "Couldn't resize this image for upload. Try a smaller image.",
    };
  }

  try {
    let resizedBlob: Blob | null;
    try {
      resizedBlob = await resizeImageToTargetBytes(image, file.size);
    } catch {
      resizedBlob = null;
    }
    if (!resizedBlob || resizedBlob.size >= file.size) {
      return {
        status: "failed",
        error: "Couldn't resize this image for upload. Try a smaller image.",
      };
    }

    return {
      status: "resized",
      file: new File([resizedBlob], filenameForResizedImage(file.name), {
        type: "image/jpeg",
        lastModified: file.lastModified,
      }),
    };
  } finally {
    image.close();
  }
}

async function loadBrowserImage(file: File): Promise<LoadedBrowserImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // Some WebKit builds support createImageBitmap but not every iOS image
      // codec. Fall through to the HTMLImageElement decoder before failing.
    }
  }

  if (typeof Image === "undefined") {
    throw new Error("No browser image decoder is available.");
  }

  const objectUrl = URL.createObjectURL(file);
  return await new Promise<LoadedBrowserImage>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({
        source: img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        close: () => URL.revokeObjectURL(objectUrl),
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Image decode failed."));
    };
    img.src = objectUrl;
  });
}

async function isAnimatedWebp(file: Pick<File, "name" | "slice" | "size" | "type">): Promise<boolean> {
  if (!isWebpFile(file)) {
    return false;
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer());
  } catch {
    return true;
  }

  if (!matchesAscii(bytes, 0, "RIFF") || !matchesAscii(bytes, 8, "WEBP")) {
    return false;
  }

  const vp8xOffset = findAscii(bytes, "VP8X");
  if (vp8xOffset >= 0 && ((bytes[vp8xOffset + 8] ?? 0) & 0x02) !== 0) {
    return true;
  }

  return findAscii(bytes, "ANIM") >= 0 || findAscii(bytes, "ANMF") >= 0;
}

function isWebpFile(file: Pick<File, "name" | "type">): boolean {
  return file.type.trim().toLowerCase() === "image/webp" || /\.webp$/i.test(file.name);
}

function findAscii(bytes: Uint8Array, pattern: string): number {
  for (let offset = 0; offset <= bytes.length - pattern.length; offset += 1) {
    if (matchesAscii(bytes, offset, pattern)) {
      return offset;
    }
  }

  return -1;
}

function matchesAscii(bytes: Uint8Array, offset: number, pattern: string): boolean {
  if (offset + pattern.length > bytes.length) {
    return false;
  }

  for (let index = 0; index < pattern.length; index += 1) {
    if (bytes[offset + index] !== pattern.charCodeAt(index)) {
      return false;
    }
  }

  return true;
}

async function resizeImageToTargetBytes(
  image: LoadedBrowserImage,
  originalBytes: number,
): Promise<Blob | null> {
  const pixelCount = image.width * image.height;
  let smallestBlob: Blob | null = null;

  if (pixelCount <= MAX_FULL_RES_COMPRESSION_PIXELS) {
    for (const quality of QUALITY_STEPS) {
      const blob = await encodeJpeg(image.source, image.width, image.height, quality);
      smallestBlob = smallestBySize(smallestBlob, blob);
      if (blob && blob.size <= IMAGE_AUTO_RESIZE_TARGET_BYTES) {
        return blob;
      }
    }
  }

  let referenceBytes = smallestBlob?.size ?? originalBytes;
  let currentScale = Math.min(
    Math.sqrt((IMAGE_AUTO_RESIZE_TARGET_BYTES / referenceBytes) * 0.9),
    0.95,
  );
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const width = Math.max(Math.floor(image.width * currentScale), 1);
    const height = Math.max(Math.floor(image.height * currentScale), 1);
    let smallestAttemptBlob: Blob | null = null;

    for (const quality of QUALITY_STEPS) {
      const blob = await encodeJpeg(image.source, width, height, quality);
      smallestBlob = smallestBySize(smallestBlob, blob);
      smallestAttemptBlob = smallestBySize(smallestAttemptBlob, blob);
      if (blob && blob.size <= IMAGE_AUTO_RESIZE_TARGET_BYTES) {
        return blob;
      }
    }

    referenceBytes = smallestAttemptBlob?.size ?? referenceBytes;
    currentScale *= Math.min(
      Math.sqrt((IMAGE_AUTO_RESIZE_TARGET_BYTES / referenceBytes) * 0.9),
      0.9,
    );
  }

  return null;
}

function smallestBySize(current: Blob | null, candidate: Blob | null): Blob | null {
  if (!candidate) {
    return current;
  }
  if (!current || candidate.size < current.size) {
    return candidate;
  }
  return current;
}

async function encodeJpeg(
  source: CanvasImageSource,
  width: number,
  height: number,
  quality: number,
): Promise<Blob | null> {
  if (typeof document === "undefined") {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  if (typeof canvas.toBlob !== "function") {
    return null;
  }

  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);

  try {
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
    });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

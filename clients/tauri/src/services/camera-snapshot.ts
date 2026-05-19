export interface CameraSnapshotResult {
  readonly imageBase64: string;
  readonly mediaType: "image/jpeg";
  readonly width: number;
  readonly height: number;
}

export async function captureCameraSnapshot(): Promise<CameraSnapshotResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera capture is not available in this WebView.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  });

  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    await waitForVideoFrame(video);

    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to create camera snapshot canvas.");
    }
    context.drawImage(video, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    const prefix = "data:image/jpeg;base64,";
    if (!dataUrl.startsWith(prefix)) {
      throw new Error("Unexpected camera snapshot encoding.");
    }
    return {
      imageBase64: dataUrl.slice(prefix.length),
      mediaType: "image/jpeg",
      width,
      height,
    };
  } finally {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
}

function waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the camera frame."));
    }, 5_000);
    const onLoadedData = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Camera video stream failed."));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("loadeddata", onLoadedData, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

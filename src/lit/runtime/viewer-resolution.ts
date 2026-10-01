/** Supersample alpha edges without scaling render cost with the screen DPR. */
export function viewerBufferSize(
  width: number,
  height: number,
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  capturePixelBudget?: number,
): { width: number; height: number } {
  const w = Math.max(1, Number.isFinite(width) ? width : 1);
  const h = Math.max(1, Number.isFinite(height) ? height : 1);
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const pixelBudget = capturePixelBudget ?? (memory !== undefined && memory <= 4 ? 1_000_000 : 2_000_000);
  const limit = Math.min(
    Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
    Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)),
  );
  const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  const scale = Math.min(2, Math.sqrt(pixelBudget / (w * h)), limit / w, limit / h, viewport[0] / w, viewport[1] / h);
  return {
    width: Math.max(1, Math.floor(w * scale)),
    height: Math.max(1, Math.floor(h * scale)),
  };
}

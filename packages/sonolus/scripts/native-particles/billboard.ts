import { Vector3 } from "three";
import {
  nativeBillboardQuad,
  type NativeBillboardTrace,
  type NativeWorldQuad,
} from "@haneoka/cassiopeia-renderer-three";

interface BillboardStyle {
  mode: 0 | 2 | 3;
  maxParticleSize: number;
}

/** Formal effect001Simple renderer bindings, keyed by exact GameObject name. */
export function simpleBillboardStyle(kind: string, name: string): BillboardStyle | undefined {
  if (kind === "tap" && (name === "ef_particle_point_center" || name === "ef_particle_point"))
    return { mode: 3, maxParticleSize: 0.5 };
  if (kind === "slide-loop") {
    if (name === "ef_particle_point_") return { mode: 2, maxParticleSize: 1 };
    if (name === "ef_particle_point ") return { mode: 0, maxParticleSize: 0.5 };
  }
  return undefined;
}

/** View-aligned and horizontal quads for the two authored Simple hold emitters. */
export function authoredBillboardQuad(
  trace: NativeBillboardTrace,
  style: BillboardStyle,
  cameraPosition: Vector3,
  viewMatrix: { elements: ArrayLike<number> },
  projectionScaleY: number,
): NativeWorldQuad {
  if (style.mode === 3)
    return nativeBillboardQuad(
      { ...trace, maxParticleSize: style.maxParticleSize },
      cameraPosition,
      viewMatrix,
      projectionScaleY,
    );
  const e = viewMatrix.elements;
  // Rows of the view rotation are the world-space camera right/up axes.
  const right = style.mode === 0 ? new Vector3(e[0]!, e[4]!, e[8]!) : new Vector3(1, 0, 0);
  const up = style.mode === 0 ? new Vector3(e[1]!, e[5]!, e[9]!) : new Vector3(0, 0, -1);
  const viewZ = e[2]! * trace.x + e[6]! * trace.y + e[10]! * trace.z + e[14]!;
  const diameter = Math.max(Math.abs(trace.sizeX), Math.abs(trace.sizeY));
  const extent = (diameter * Math.abs(projectionScaleY)) / (2 * Math.max(Math.abs(viewZ), 1e-6));
  const scale = style.maxParticleSize > 0 ? Math.min(1, style.maxParticleSize / Math.max(extent, 1e-6)) : 1;
  const cosine = Math.cos(trace.rotation),
    sine = Math.sin(trace.rotation);
  const corner = (u: number, v: number) => {
    const x = (u + trace.pivotX) * trace.sizeX;
    const y = (v + trace.pivotY) * trace.sizeY;
    return new Vector3(trace.x, trace.y, trace.z)
      .addScaledVector(right, (cosine * x + sine * y) * scale)
      .addScaledVector(up, (-sine * x + cosine * y) * scale);
  };
  return { corners: [corner(-0.5, -0.5), corner(0.5, -0.5), corner(0.5, 0.5), corner(-0.5, 0.5)], uv: [0, 0, 1, 1] };
}

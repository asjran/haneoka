import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, Matrix4, Mesh, Quaternion, Vector3, type Camera, type ShaderMaterial } from "three";
import type { NativeIntroScene } from "./NativeIntroScene";
import { NativeIntroEmitter } from "./NativeIntroParticles";

export interface NativeIntroParticleVisual {
  transformId: string;
  emitter: NativeIntroEmitter;
  material: ShaderMaterial;
  sortingOrder: number;
  minParticleSize: number;
  maxParticleSize: number;
}
interface Instance { spec: NativeIntroParticleVisual; mesh: Mesh; positions: BufferAttribute; colours: BufferAttribute }

/** Native renderMode3 upright camera-facing billboards, into the existing effect camera pass. */
export class NativeIntroParticleLayer {
  readonly group = new Group();
  private readonly instances: Instance[] = [];
  private readonly world = new Matrix4();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly scaledRight = new Vector3();
  private readonly scaledUp = new Vector3();
  private readonly inverseRotation = new Quaternion();
  constructor(private readonly scene: NativeIntroScene, specs: ReadonlyArray<NativeIntroParticleVisual>) {
    for (const spec of specs) {
      const count = spec.emitter.system.maxParticles;
      const geometry = new BufferGeometry();
      const positions = new BufferAttribute(new Float32Array(count * 12), 3).setUsage(DynamicDrawUsage);
      const colours = new BufferAttribute(new Float32Array(count * 16), 4).setUsage(DynamicDrawUsage);
      const uv = new Float32Array(count * 8), indices = new Uint32Array(count * 6);
      for (let i = 0; i < count; i++) {
        uv.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
        indices.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
      }
      geometry.setAttribute("position", positions); geometry.setAttribute("particleColour", colours);
      geometry.setAttribute("uv", new BufferAttribute(uv, 2)); geometry.setIndex(new BufferAttribute(indices, 1));
      geometry.setDrawRange(0, 0);
      // Each system uses a distinct material: its authored per-particle colour participates in HDR math.
      spec.material.vertexShader = spec.material.vertexShader.replace("varying vec4 vHdrColor;", "attribute vec4 particleColour;\nvarying vec4 vHdrColor;")
        .replace("2.0 * uTintColor * uTintColor * uVertexColour", "2.0 * uTintColor * uTintColor * uVertexColour * particleColour");
      const mesh = new Mesh(geometry, spec.material); mesh.frustumCulled = false; mesh.renderOrder = spec.sortingOrder;
      mesh.name = `OurNotesNativeIntroStars:${spec.transformId}`;
      this.group.add(mesh); this.instances.push({ spec, mesh, positions, colours });
    }
  }
  tick(gameDelta: number): void {
    for (const { spec } of this.instances) {
      this.world.fromArray(this.scene.boneWorldMatrix(spec.transformId));
      spec.emitter.tick(this.scene.isActive(spec.transformId), this.world, gameDelta);
    }
  }
  update(camera: Camera): void {
    const cameraElements = camera.matrixWorld.elements;
    for (const { spec, mesh, positions, colours } of this.instances) {
      let count = 0;
      const output = positions.array as Float32Array, colour = colours.array as Float32Array;
      for (const particle of spec.emitter.particles) {
        const x = particle.position[0], y = particle.position[1], z = -particle.position[2];
        const depth = Math.abs((x - cameraElements[12]!) * cameraElements[8]! + (y - cameraElements[13]!) * cameraElements[9]! + (z - cameraElements[14]!) * cameraElements[10]!);
        // Fraction of viewport height, using the real perspective projection (m_MaxParticleSize .5).
        const viewportHeight = 2 * depth / Math.abs(camera.projectionMatrix.elements[5]!);
        const size = spec.emitter.particleSize(particle);
        // Build the vertical camera plane in original Unity coordinates; reflect Z once at output.
        this.right.set(cameraElements[0]!, 0, -cameraElements[2]!);
        if (this.right.lengthSq() === 0) this.right.set(1, 0, 0);
        else this.right.normalize();
        this.up.set(0, 1, 0);
        const inverse = this.inverseRotation.copy(particle.birthRotation).invert();
        this.scaledRight.copy(this.right).applyQuaternion(inverse).multiply(particle.birthScale).applyQuaternion(particle.birthRotation);
        this.scaledUp.copy(this.up).applyQuaternion(inverse).multiply(particle.birthScale).applyQuaternion(particle.birthRotation);
        const extent = Math.abs(size) * Math.max(this.scaledRight.length(), this.scaledUp.length());
        const lower = spec.minParticleSize * viewportHeight, upper = spec.maxParticleSize * viewportHeight;
        const ratio = extent > 0 && viewportHeight > 0 ? Math.max(lower, Math.min(upper, extent)) / extent : 1;
        const half = size * ratio / 2;
        for (let vertex = 0; vertex < 4; vertex++) {
          const horizontal = vertex === 0 || vertex === 3 ? -half : half, vertical = vertex < 2 ? -half : half;
          const offset = count * 12 + vertex * 3;
          output[offset] = x + this.scaledRight.x * horizontal + this.scaledUp.x * vertical;
          output[offset + 1] = y + this.scaledRight.y * horizontal + this.scaledUp.y * vertical;
          output[offset + 2] = z - this.scaledRight.z * horizontal - this.scaledUp.z * vertical;
          colour.set(particle.colour, count * 16 + vertex * 4);
        }
        count++;
      }
      mesh.geometry.setDrawRange(0, count * 6); mesh.visible = count > 0;
      if (count) {
        positions.clearUpdateRanges(); positions.addUpdateRange(0, count * 12);
        colours.clearUpdateRanges(); colours.addUpdateRange(0, count * 16);
        positions.needsUpdate = true; colours.needsUpdate = true;
      }
    }
  }
  dispose(): void {
    for (const { spec, mesh } of this.instances) { spec.emitter.dispose(); mesh.geometry.dispose(); mesh.removeFromParent(); }
    this.instances.length = 0; this.group.removeFromParent();
  }
}

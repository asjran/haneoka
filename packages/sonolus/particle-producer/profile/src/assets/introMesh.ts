/** Original Unity mesh attributes, with source-space coordinates retained for every backend. */
export interface NativeIntroMeshData {
  positions: Float32Array;
  uv: Float32Array;
  indices: Uint32Array;
  boneWeights: Float32Array;
  boneIndices: Uint32Array;
  influencesPerVertex: number;
  /** Column-major inverse bind matrices, in original Unity coordinates. */
  bindPoses: ReadonlyArray<Float32Array>;
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native intro mesh record");
  return value as Record<string, unknown>;
};
const integer = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid native intro mesh integer");
  return value;
};
const number = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid native intro mesh float");
  return value;
};
const bytes = (value: unknown): Uint8Array => {
  if (!Array.isArray(value) || value.some((n) => typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255))
    throw new Error("Native intro mesh requires projected byte arrays");
  return Uint8Array.from(value);
};

/** Decode the actual lane_mesh multi-stream Float32 / UInt32 channels and authored submesh index range. */
export function parseNativeIntroMesh(value: unknown): NativeIntroMeshData {
  const data = record(record(value).data);
  const vertexData = record(data.m_VertexData);
  const count = integer(vertexData.m_VertexCount);
  if (!count || count > 1_048_576) throw new Error("Native intro vertex count outside supported range");
  const channels = vertexData.m_Channels;
  if (!Array.isArray(channels) || channels.length < 14) throw new Error("Native intro skin channels missing");
  const channel = (index: number) => record(channels[index]);
  const rawBytes = bytes(vertexData.m_DataSize);
  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  const strides = new Map<number, number>();
  for (const item of channels) {
    const c = record(item), dimension = integer(c.dimension);
    if (!dimension) continue;
    const format = integer(c.format), stream = integer(c.stream), offset = integer(c.offset);
    if ((format !== 0 && format !== 10) || dimension > 4 || stream > 7) throw new Error("Unsupported native intro vertex format");
    strides.set(stream, Math.max(strides.get(stream) ?? 0, offset + dimension * 4));
  }
  const offsets = new Map<number, number>();
  let byteOffset = 0;
  for (const stream of [...strides.keys()].sort((a, b) => a - b)) {
    byteOffset = Math.ceil(byteOffset / 16) * 16;
    offsets.set(stream, byteOffset);
    byteOffset += count * strides.get(stream)!;
  }
  if (byteOffset > view.byteLength) throw new Error("Truncated native intro vertex streams");
  const read = (index: number, wantedFormat: number, expectedDimensions?: number) => {
    const c = channel(index), dimension = integer(c.dimension), format = integer(c.format);
    if (!dimension || format !== wantedFormat || (expectedDimensions !== undefined && dimension !== expectedDimensions))
      throw new Error("Native intro channel contract mismatch");
    const stream = integer(c.stream), start = offsets.get(stream)! + integer(c.offset), stride = strides.get(stream)!;
    const result = wantedFormat === 10 ? new Uint32Array(count * dimension) : new Float32Array(count * dimension);
    for (let vertex = 0; vertex < count; vertex++) for (let component = 0; component < dimension; component++) {
      const offset = start + vertex * stride + component * 4;
      const value = wantedFormat === 10 ? view.getUint32(offset, true) : view.getFloat32(offset, true);
      if (!Number.isFinite(value)) throw new Error("Non-finite native intro vertex value");
      result[vertex * dimension + component] = value;
    }
    return result;
  };
  const positions = read(0, 0, 3) as Float32Array;
  const uv = read(4, 0, 2) as Float32Array;
  const boneWeights = read(12, 0) as Float32Array;
  const boneIndices = read(13, 10, integer(channel(12).dimension)) as Uint32Array;
  const bind = data.m_BindPose;
  if (!Array.isArray(bind) || !bind.length) throw new Error("Native intro inverse bind matrices missing");
  const bindPoses = bind.map((item) => {
    const matrix = record(item), output = new Float32Array(16);
    for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++)
      output[column * 4 + row] = number(matrix[`e${row}${column}`]);
    return output;
  });
  for (let index = 0; index < boneIndices.length; index++) {
    if (boneWeights[index]! < 0) throw new Error("Negative native intro skin weight");
    if (boneWeights[index]! > 0 && boneIndices[index]! >= bindPoses.length) throw new Error("Native intro bone index outside bind table");
  }
  const submeshes = data.m_SubMeshes;
  if (!Array.isArray(submeshes) || submeshes.length !== 1) throw new Error("Native lane intro requires its authored single submesh");
  const submesh = record(submeshes[0]);
  if (integer(submesh.topology) !== 0) throw new Error("Native intro submesh is not triangles");
  const indexFormat = integer(data.m_IndexFormat);
  if (indexFormat > 1) throw new Error("Unsupported native intro index format");
  const indexWidth = indexFormat === 1 ? 4 : 2, indexBytes = bytes(data.m_IndexBuffer);
  const indexView = new DataView(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength);
  const firstByte = integer(submesh.firstByte), indexCount = integer(submesh.indexCount), baseVertex = integer(submesh.baseVertex);
  if (indexCount % 3 || firstByte + indexCount * indexWidth > indexView.byteLength) throw new Error("Invalid native intro submesh index range");
  const indices = new Uint32Array(indexCount);
  for (let index = 0; index < indexCount; index++) {
    const offset = firstByte + index * indexWidth;
    indices[index] = baseVertex + (indexWidth === 4 ? indexView.getUint32(offset, true) : indexView.getUint16(offset, true));
    if (indices[index]! >= count) throw new Error("Native intro triangle references missing vertex");
  }
  return { positions, uv, indices, boneWeights, boneIndices, influencesPerVertex: integer(channel(12).dimension), bindPoses };
}

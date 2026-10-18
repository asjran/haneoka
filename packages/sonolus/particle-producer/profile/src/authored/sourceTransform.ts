export type Vec3 = { x: number; y: number; z: number };
export type Quaternion = Vec3 & { w: number };

export const multiply = (a: ArrayLike<number>, b: ArrayLike<number>): Float64Array => {
  const out = new Float64Array(16);
  for (let column = 0; column < 4; column++)
    for (let row = 0; row < 4; row++)
      out[column * 4 + row] =
        a[row]! * b[column * 4]! +
        a[4 + row]! * b[column * 4 + 1]! +
        a[8 + row]! * b[column * 4 + 2]! +
        a[12 + row]! * b[column * 4 + 3]!;
  return out;
};
export const trs = (p: Vec3, q: Quaternion, s: Vec3): Float64Array => {
  const xx = q.x * q.x,
    yy = q.y * q.y,
    zz = q.z * q.z;
  const xy = q.x * q.y,
    xz = q.x * q.z,
    yz = q.y * q.z;
  const wx = q.w * q.x,
    wy = q.w * q.y,
    wz = q.w * q.z;
  return Float64Array.of(
    (1 - 2 * (yy + zz)) * s.x,
    2 * (xy + wz) * s.x,
    2 * (xz - wy) * s.x,
    0,
    2 * (xy - wz) * s.y,
    (1 - 2 * (xx + zz)) * s.y,
    2 * (yz + wx) * s.y,
    0,
    2 * (xz + wy) * s.z,
    2 * (yz - wx) * s.z,
    (1 - 2 * (xx + yy)) * s.z,
    0,
    p.x,
    p.y,
    p.z,
    1,
  );
};
export const eulerZxy = (e: Vec3): Quaternion => {
  const r = Math.PI / 360;
  const sx = Math.sin(e.x * r),
    cx = Math.cos(e.x * r),
    sy = Math.sin(e.y * r),
    cy = Math.cos(e.y * r);
  const sz = Math.sin(e.z * r),
    cz = Math.cos(e.z * r);
  return {
    x: sx * cy * cz + cx * sy * sz,
    y: cx * sy * cz - sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz,
  };
};
export const identity = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);

export const multiplyQuaternion = (a: Quaternion, b: Quaternion): Quaternion => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});

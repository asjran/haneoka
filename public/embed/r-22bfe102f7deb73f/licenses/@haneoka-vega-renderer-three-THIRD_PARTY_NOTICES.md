# Third-party notices

Runtime and development dependencies are governed by their respective
packages and licenses. This project installs Vega, Three.js, Howler,
TypeScript, and Vitest as dependencies; it does not vendor their source or
binaries in the published package.

The original color-math implementation in this repository is informed by
public specifications and scientific literature:

- W3C CSS Color 4 for extended sRGB transfer functions, D65 chromaticity, and
  linear-sRGB/XYZ matrices:
  https://www.w3.org/TR/css-color-4/
- W3C Compositing and Blending Level 1 for soft-light blending:
  https://www.w3.org/TR/compositing-1/
- CIECAM02/CIECAT02 as documented by the International Color Consortium:
  https://www.color.org/specification/ICC.2-2019.pdf

Those publications are references for equations and numeric color-space
definitions. No reference implementation source is copied into this package.

This project accepts host-supplied scene data whose schema may use Unity names.
It does not contain Unity software source, packages, shader programs, binaries,
or assets, and the Unity Companion License does not govern any file in the
current source tree.

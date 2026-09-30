# Haneoka Sonolus service adapter

The website keeps release-backed catalog, level-template and runtime chart-data
providers here. Chart conversion is re-exported from
`@haneoka/cassiopeia-plugin-sonolus`; the four engine targets are published by
the independent `@haneoka/sonolus-our-notes` package. No engine or
chart-normalization copy is retained in this website package.

Use `pnpm sonolus:build` to build the locked native engine and assemble the
host's assets. Production HTTP routes and release storage remain website-owned.

Generated resources include the native engine's Haneoka MPL-2.0 license and
the preserved upstream Project SEKAI MIT notice.

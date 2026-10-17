import assert from "node:assert/strict";
import { test } from "node:test";
import { audioTrackKey } from "../../src/lib/audio-track-key.ts";

for (const [provider, playlistId, id, url] of [
  ["gbp", "bestdori:jp:1", "1", "/api/v1/garupa/bestdori/jp/media/sound/001"],
  ["our-notes", "our-notes:intl:100001", "100001", "/assets/intl/audio/100001.mp3"],
]) {
  for (const server of ["jp", "intl"]) {
    test(`${provider} catalogue and playlist identify the same song on ${server}`, () => {
      const playlist = audioTrackKey({ id: playlistId, url });
      const catalogue = audioTrackKey({ id: `${id}-3`, url, songKey: `${provider}:${server}:${id}` });
      assert.equal(catalogue, playlist);
      assert.equal(audioTrackKey({ id, url, songKey: catalogue }), catalogue);
    });
  }
}

test("song identities distinguish games and songs", () => {
  const key = songKey => audioTrackKey({ id: "1", url: "/audio", songKey });
  assert.notEqual(key("gbp:jp:1"), key("our-notes:jp:1"));
  assert.notEqual(key("gbp:jp:1"), key("gbp:jp:2"));
});

test("regionless saved identities and unrelated explicit identities remain valid", () => {
  for (const songKey of ["gbp:1", "our-notes:100001", "sekai:jp:1", "custom:song", "our-notes:intl:bgm:home"]) {
    assert.equal(audioTrackKey({ id: "1", url: "/audio", songKey }), songKey);
  }
});

test("unknown audio still distinguishes sources with the same id", () => {
  assert.notEqual(audioTrackKey({ id: "1", url: "/a.mp3" }), audioTrackKey({ id: "1", url: "/b.mp3" }));
});

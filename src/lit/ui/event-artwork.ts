import { html, nothing } from "lit";
import { nextImageCandidate } from "./lazy-images";
import "../../styles/event-artwork.css";

/** The game's authored home banner, shared by event list and table thumbnails. */
export function eventBanner(image: string, label = "", deferred = true) {
  return html`
    <img
      class="event-banner"
      src=${deferred ? nothing : image}
      data-src=${deferred ? image : nothing}
      alt=${label}
      width="420"
      height="180"
      decoding="async"
      @error=${nextImageCandidate}
    />
  `;
}

/** The event's own illustration and title logo, composed inside a catalog tile. */
export function eventArtwork(image: string, logo: string, label: string, deferred = true) {
  return html`
    <span class="event-artwork" role="img" aria-label=${label}>
      <img
        class="event-artwork__background"
        src=${deferred ? nothing : image}
        data-src=${deferred ? image : nothing}
        alt=""
        decoding="async"
        @error=${nextImageCandidate}
      />
      <img
        class="event-artwork__logo"
        src=${deferred ? nothing : logo}
        data-src=${deferred ? logo : nothing}
        alt=""
        decoding="async"
        @error=${nextImageCandidate}
      />
    </span>
  `;
}

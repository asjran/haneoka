import { html, nothing } from "lit";
import { nextImageCandidate } from "./lazy-images";
import "../../styles/event-artwork.css";

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

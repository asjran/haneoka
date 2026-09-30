/**
 * Detail sections for the rotating game systems (events, real lives, gacha,
 * login campaigns, shop, exchange, circle, challenge, missions, passes).
 *
 * These collections render through the generic catalogue screen; this module
 * is the per-resource body of the detail pane, in the same position — and
 * with the same house patterns — as card-detail is for cards and
 * song-detail-rewards is for songs: titled sections, spec lists, object
 * rows and related grids from the shared detail pattern, never a private
 * component tree.
 */

import { html, nothing } from "lit";
import {
  availableShopCurrencies,
  convertShopPrice,
  fetchShopFxRates,
  formatMoney,
  localeShopCurrency,
  moneyName,
  shopPriceEntries,
} from "../lib/shop-currency";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { icon } from "./ui/icon";
import { tile } from "./ui/tile";
import { nextImageCandidate } from "./ui/lazy-images";
import { episodeArtwork } from "../lib/story-artwork";
import { storyTile } from "./shared/story-tile";
import { localizedContent } from "./ui/localized-content";
import { renderLevelSwitch } from "./ui/level-switch";
import "@material/web/progress/circular-progress.js";

type Item = Record<string, unknown>;
type Controller = Record<string, any>;

const EVENT_SCORE_RANK_NAMES = ["", "E", "D", "C", "B", "A", "S", "SS"];

function canonicalHref(c: Controller, href: string): string {
  if (!href) return "";
  return typeof c.resourceHref === "function" ? String(c.resourceHref(href) || href) : href;
}

export interface GachaSimState {
  draws: number;
  spent: number;
  points: number;
  currency: string;
  currencyImage: string;
  firstUsed: string[];
  tally: Record<string, number>;
  results: Array<{ prize: Item; rarity: number }>;
}

/** Real-time rate session for the open shop detail; owned by the screen like sim. */
export interface ShopFxState {
  status: "loading" | "ready" | "error";
  rates?: import("../lib/shop-currency").ShopFxRates;
}

const rateText = (value: unknown) =>
  Number(value) > 0 ? `${(Number(value) * 100).toLocaleString(undefined, { maximumFractionDigits: 3 })}%` : "";

const RARITY_NAMES: Record<number, string> = { 2: "R", 3: "SR", 4: "SSR" };

/** One reward row: emblem, linked name, secondary credit, trailing number. */
function rewardRow(c: Controller, reward: Item, trailing: unknown = nothing, badgeLabel?: string) {
  const name = c.localized(reward.name);
  if (!name) return nothing;
  const secondary = c.localized(reward.secondary);
  const image = String(reward.image || "");
  const href = canonicalHref(c, String(reward.href || ""));
  const count = Number(reward.count || 0);
  const badgeKey = reward.pickup ? "pickup" : reward.bonus ? "bonus" : "";
  const badge =
    badgeLabel || badgeKey
      ? html`
          <span class="chip chip--static chip--assist" style="--chip-height:22px">
            <span class="chip__label">
              ${badgeLabel || c.label(badgeKey, badgeKey === "pickup" ? "Pickup" : "Bonus")}
            </span>
          </span>
        `
      : nothing;
  const copy = html`
    <span>
      ${name}
      ${
        secondary
          ? html`
              <small class="detail-copy">${secondary}</small>
            `
          : nothing
      }
      ${badge}
    </span>
  `;
  const trailingNode =
    trailing === nothing && count > 1
      ? html`
          <strong>×${count.toLocaleString(c.settings.locale)}</strong>
        `
      : trailing;
  const body = html`
    ${
      image
        ? html`
            <img src=${image} alt="" loading="lazy" decoding="async" />
          `
        : icon("redeem", 32)
    }
    ${copy} ${trailingNode}
  `;
  return href
    ? html`
        <a class="detail-object" href=${href}>${body}</a>
      `
    : html`
        <div class="detail-object">${body}</div>
      `;
}

function rewardSection(
  c: Controller,
  rewards: Item[],
  title: string,
  options: {
    kind?: any;
    collapsible?: boolean;
    /** Per-row trailing cell, e.g. a gacha prize's rate. */
    trailing?: (reward: Item) => unknown;
  } = {},
) {
  if (!rewards.length) return nothing;
  const list = html`
    <ul class="detail-object-list" role="list">
      ${rewards.map((reward) => rewardRow(c, reward, options.trailing ? options.trailing(reward) : nothing))}
    </ul>
  `;
  if (options.collapsible) return fold(title, list);
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(title, options.kind || "rewards", { count: rewards.length })} ${list}
    </section>
  `;
}

/**
 * A disclosure in the house style: one Material summary row (title, optional
 * trailing meta, chevron) over an indented body, mirroring the manual's
 * entries. Summaries stay inside the section rhythm instead of looking like
 * bare unstyled <details>.
 */
export function fold(title: unknown, content: unknown, meta: unknown = nothing) {
  return html`
    <details class="detail-fold">
      <summary>
        <span class="detail-fold__title">${title}</span>
        ${
          meta
            ? html`
                <span class="detail-fold__meta">${meta}</span>
              `
            : nothing
        }
        <svg class="material-icon detail-fold__chevron" width="20" height="20" aria-hidden="true">
          <use href="/icons.svg#expand_more"></use>
        </svg>
      </summary>
      <div class="detail-fold__body">${content}</div>
    </details>
  `;
}

/** Currency-or-plain cost line with the emblem leading the figure. */
function costLine(amount: string, image: unknown) {
  if (!amount) return "";
  const emblem =
    typeof image === "string" && image
      ? html`
          <img src=${image} alt="" width="18" height="18" class="detail-cost__emblem" />
        `
      : nothing;
  return html`
    <span class="detail-cost">
      ${emblem}
      <span>${amount}</span>
    </span>
  `;
}

/** Pickup and other headline rewards, as the same tiles the card catalogue uses. */
function featuredGrid(c: Controller, featured: Item[]) {
  if (!featured.length) return nothing;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("featured", "Featured"), "cards", { count: featured.length })}
      <ul class="related-grid related-grid--wide" role="list">
        ${featured.map((reward) => {
          const title = c.localized(reward.name);
          const image = String(reward.image || "");
          return tile({
            kind: "member",
            title,
            titleLanguage: c.localizedLanguage(reward.name),
            subtitle: c.localized(reward.secondary),
            label: title,
            image,
            href: String(reward.href || "") || undefined,
            fit: "contain",
            marks: rateText(reward.rate)
              ? [{ at: "bottom-start" as const, text: rateText(reward.rate), label: c.label("rates", "Rates") }]
              : undefined,
          });
        })}
      </ul>
    </section>
  `;
}

/** The game's own ratio table: one collapsible group per slot, prizes inside. */
function renderRates(c: Controller, item: Item) {
  const rates = Array.isArray(item.rates) ? (item.rates as Item[]) : [];
  if (!rates.length) return nothing;
  const slotLabel = (row: Item) =>
    `${c.label(String(row.resourceType || ""), String(row.resourceType || ""))} · ${c.label("rarity", "Rarity")} ${
      RARITY_NAMES[Number(row.rarity || 0)] || "—"
    }`;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("rates", "Rates"), "works", { count: rates.length })}
      <div class="detail-fold-stack">
        ${rates.map((row) => {
          const prizes = (Array.isArray(row.prizes) ? row.prizes : []) as Item[];
          if (!prizes.length) return nothing;
          return fold(
            slotLabel(row),
            html`
              <ul class="detail-object-list" role="list">
                ${prizes.map((prize) =>
                  rewardRow(
                    c,
                    prize,
                    html`
                      <strong>${rateText(prize.rate)}</strong>
                    `,
                  ),
                )}
              </ul>
            `,
            rateText(row.rate),
          );
        })}
      </div>
      ${
        c.localized(item.warning)
          ? html`
              <p class="detail-copy">${c.plainGameText(item.warning)}</p>
            `
          : nothing
      }
    </section>
  `;
}

function renderDrawOptions(c: Controller, item: Item) {
  const options = Array.isArray(item.drawOptions) ? (item.drawOptions as Item[]) : [];
  if (!options.length) return nothing;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("drawOptions", "Draw options"), "content", { count: options.length })}
      <dl class="spec-list spec-list--split">
        ${options.map((option) => {
          const draws = Number(option.drawCount || 1);
          const price = Number(option.price || 0);
          const firstPrice = Number(option.firstPrice || 0);
          const ensuredRarity = Number(option.guaranteedRarity || 0);
          const ensuredCount = Number(option.guaranteedCount || 0);
          const limit = Number(option.limitCount || 0);
          const currency = c.localized(option.currency);
          const priceText =
            price > 0
              ? costLine(`${price.toLocaleString(c.settings.locale)} ${currency}`, option.currencyImage)
              : c.label("free", "Free");
          return html`
            <div>
              <dt>
                ${c
                  .label(draws === 1 ? "drawOne" : "draw", "{count} draws")
                  .replace("{count}", draws.toLocaleString(c.settings.locale))}
              </dt>
              <dd>
                ${priceText}
                ${
                  firstPrice > 0 && firstPrice !== price
                    ? html`
                        · ${c.label("firstTime", "First time")} ${firstPrice.toLocaleString(c.settings.locale)}
                      `
                    : nothing
                }
                ${
                  ensuredRarity
                    ? html`
                        · ${c.label("guaranteed", "Guaranteed")} ${RARITY_NAMES[ensuredRarity] || ""}
                        ${ensuredCount > 1 ? `×${ensuredCount}` : ""}
                      `
                    : nothing
                }
                ${
                  Number(option.gachaPoint || 0)
                    ? html`
                        · ${Number(option.gachaPoint).toLocaleString(c.settings.locale)} ${c.label("gachaPoint", "pt")}
                      `
                    : nothing
                }
                ${
                  limit
                    ? html`
                        · ${c.label("limit", "Limit")} ${limit.toLocaleString(c.settings.locale)}
                      `
                    : nothing
                }
              </dd>
            </div>
          `;
        })}
      </dl>
    </section>
  `;
}

/**
 * The simulator follows the reconstructed draw contract: a slot is rolled by
 * lot weight, a prize by its absolute basis-point rate inside the slot, and a
 * multi-draw whose rolls all miss the product's ensured rarity re-rolls its
 * last slot from the qualifying slots only — the game's 確定枠.
 */
export function drawGacha(c: Controller, item: Item, option: Item) {
  const rates = (Array.isArray(item.rates) ? item.rates : []) as Item[];
  if (!rates.length) return;
  const pickWeighted = (rows: Item[], weight: (row: Item) => number) => {
    const total = rows.reduce((sum, row) => sum + weight(row), 0);
    let roll = Math.random() * total;
    for (const row of rows) {
      roll -= weight(row);
      if (roll <= 0) return row;
    }
    return rows[rows.length - 1];
  };
  const drawOnce = (pool: Item[] = rates): { prize: Item; rarity: number } => {
    const group = pickWeighted(pool, (row) => Number(row.rate) || 0);
    const prizes = (Array.isArray(group.prizes) ? group.prizes : []) as Item[];
    const prize = prizes.length > 1 ? pickWeighted(prizes, (row) => Number(row.rate) || 0) : prizes[0] || {};
    return { prize, rarity: Number(group.rarity || 0) };
  };
  const draws = Math.max(1, Number(option.drawCount || 1));
  const results: Array<{ prize: Item; rarity: number }> = [];
  for (let index = 0; index < draws; index += 1) results.push(drawOnce());
  const ensured = Number(option.guaranteedRarity || 0);
  if (ensured && !results.some((result) => result.rarity >= ensured)) {
    const pool = rates.filter((row) => Number(row.rarity || 0) >= ensured);
    if (pool.length) results[results.length - 1] = drawOnce(pool);
  }
  const optionKey = String(option.id ?? option.drawCount ?? "");
  const previous: GachaSimState = c.sim || {
    draws: 0,
    spent: 0,
    points: 0,
    currency: c.localized(option.currency),
    currencyImage: String(option.currencyImage || ""),
    firstUsed: [],
    tally: {},
    results: [],
  };
  const price = Number(option.price || 0);
  const firstTime = Number(option.firstPrice || 0) > 0 && !previous.firstUsed.includes(optionKey);
  const spent = firstTime ? Number(option.firstPrice || 0) : price;
  const tally = { ...previous.tally };
  for (const result of results) tally[String(result.rarity)] = (tally[String(result.rarity)] || 0) + 1;
  c.sim = {
    draws: previous.draws + draws,
    spent: previous.spent + spent,
    // _gachaPoint is granted per product consume, not per single draw.
    points: previous.points + Number(option.gachaPoint || 0),
    currency: previous.currency || c.localized(option.currency),
    currencyImage: previous.currencyImage || String(option.currencyImage || ""),
    firstUsed: firstTime ? [...previous.firstUsed, optionKey] : previous.firstUsed,
    tally,
    results: [...results.reverse(), ...previous.results],
  };
  c.requestUpdate();
}

function renderSimulator(c: Controller, item: Item) {
  const options = Array.isArray(item.drawOptions) ? (item.drawOptions as Item[]) : [];
  if (!options.length) return nothing;
  const sim = c.sim as GachaSimState | null;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("simulator", "Simulator"), "difficulty")}
      <div class="field-stack">
        ${options.map((option) => {
          const draws = Number(option.drawCount || 1);
          const price = Number(option.price || 0);
          const currency = c.localized(option.currency);
          const cost = price > 0 ? `${price.toLocaleString(c.settings.locale)} ${currency}` : c.label("free", "Free");
          return html`
            <button class="button button--tonal" type="button" @click=${() => drawGacha(c, item, option)}>
              ${icon("casino", 18)}
              ${c
                .label(draws === 1 ? "drawOne" : "draw", "{count} draws")
                .replace("{count}", draws.toLocaleString(c.settings.locale))}
              · ${cost}
            </button>
          `;
        })}
        ${
          sim?.results?.length
            ? html`
                <button class="button button--text" type="button" @click=${() => ((c.sim = null), c.requestUpdate())}>
                  ${c.label("reset", "Reset")}
                </button>
              `
            : nothing
        }
      </div>
      ${
        sim?.results?.length
          ? html`
              <dl class="spec-list spec-list--split">
                <div>
                  <dt>${c.label("drawCount", "Draws")}</dt>
                  <dd>${sim.draws.toLocaleString(c.settings.locale)}</dd>
                </div>
                <div>
                  <dt>${c.label("spent", "Spent")}</dt>
                  <dd>
                    ${costLine(`${sim.spent.toLocaleString(c.settings.locale)} ${sim.currency}`, sim.currencyImage)}
                  </dd>
                </div>
                ${
                  sim.points
                    ? html`
                        <div>
                          <dt>${c.label("gachaPoint", "Gacha points")}</dt>
                          <dd>${sim.points.toLocaleString(c.settings.locale)}</dd>
                        </div>
                      `
                    : nothing
                }
                ${Object.entries(sim.tally)
                  .sort((left, right) => Number(right[0]) - Number(left[0]))
                  .map(
                    ([rarity, count]) => html`
                      <div>
                        <dt>${RARITY_NAMES[Number(rarity)] || rarity}</dt>
                        <dd>${count.toLocaleString(c.settings.locale)}</dd>
                      </div>
                    `,
                  )}
              </dl>
              <ul class="related-grid related-grid--wide" role="list">
                ${sim.results.map(({ prize, rarity }) => {
                  const title = c.localized(prize.name) || c.label(RARITY_NAMES[rarity] || "reward", "Reward");
                  const image = String(prize.image || "");
                  return tile({
                    kind: "member",
                    title,
                    titleLanguage: c.localizedLanguage(prize.name),
                    subtitle: rarity ? RARITY_NAMES[rarity] : "",
                    label: title,
                    image,
                    href: String(prize.href || "") || undefined,
                    fit: "contain",
                    marks: prize.pickup
                      ? [
                          {
                            at: "end" as const,
                            text: c.label("pickup", "Pickup"),
                            accent: "var(--md-sys-color-primary)",
                          },
                        ]
                      : undefined,
                  });
                })}
              </ul>
            `
          : nothing
      }
    </section>
  `;
}

/** Day-indexed reward sheets, listed one day per row rather than one row per item. */
function renderLoginDays(c: Controller, rewards: Item[]) {
  if (!rewards.length) return nothing;
  const days = new Map<number, Item[]>();
  for (const slot of rewards) {
    const key = Number(slot.day || 0);
    const list = days.get(key) || [];
    list.push((slot.reward || {}) as Item);
    days.set(key, list);
  }
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("dailyRewards", "Daily rewards"), "rewards", { count: days.size })}
      <dl class="spec-list spec-list--split">
        ${[...days.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(
            ([day, rows]) => html`
              <div>
                <dt>${c.label("dayN", "Day {day}").replace("{day}", day.toLocaleString(c.settings.locale))}</dt>
                <dd>
                  <div class="detail-object-list">${rows.map((reward) => rewardRow(c, reward))}</div>
                </dd>
              </div>
            `,
          )}
      </dl>
    </section>
  `;
}

function renderExchangeGoods(c: Controller, item: Item) {
  const products = Array.isArray(item.products) ? (item.products as Item[]) : [];
  if (!products.length) return nothing;
  const currency = (item.currency || {}) as Item;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("exchangeGoods", "Exchange goods"), "content", { count: products.length })}
      <ul class="detail-object-list" role="list">
        ${products.map((product) => {
          const cost = Number(product.cost || 0);
          return rewardRow(
            c,
            (product.reward || {}) as Item,
            html`
              <strong>
                ${costLine(`${cost.toLocaleString(c.settings.locale)} ${c.localized(currency.name)}`, currency.image)}
              </strong>
            `,
          );
        })}
      </ul>
    </section>
  `;
}

function renderShopFacts(c: Controller, item: Item) {
  const payment = (item.payment || {}) as Item;
  const rows: Array<{ label: string; value: unknown }> = [];
  if (payment.advertisement) {
    rows.push({ label: c.detailLabel("price"), value: c.label("watchAd", "Watch an ad") });
  } else {
    // Cash entries read like the song page's difficulty facts: one spec row
    // per storefront currency, with the real-time conversion into the
    // reading locale's own currency attached under the price. In-game
    // currency rows keep the emblem figure.
    const fx = c.fx as ShopFxState | null;
    const target = localeShopCurrency(c.settings.locale);
    for (const { code, amount } of shopPriceEntries(payment.prices)) {
      const price = formatMoney(amount, code, c.settings.locale);
      const rate = fx?.status === "ready" && code !== target ? fx.rates?.rates[code] : undefined;
      const converted =
        rate && Number.isFinite(convertShopPrice(amount, code, target, fx!.rates!))
          ? html`
              <small class="shop-fx__note">
                ≈ ${formatMoney(convertShopPrice(amount, code, target, fx!.rates!), target, c.settings.locale)}
              </small>
            `
          : nothing;
      rows.push({
        label: moneyName(code, c.settings.locale),
        value: html`
          ${price} ${converted}
        `,
      });
    }
    if (!availableShopCurrencies(payment.prices).length) {
      if (payment.storePurchase && !Number(payment.price || 0))
        rows.push({ label: c.detailLabel("price"), value: c.label("inAppPurchase", "In-app purchase") });
      else if (Number(payment.price || 0))
        rows.push({
          label: c.detailLabel("price"),
          value: costLine(
            `${Number(payment.price).toLocaleString(c.settings.locale)} ${c.localized(payment.currency)}`,
            payment.currencyImage,
          ),
        });
    }
  }
  if (Number(item.limit || 0))
    rows.push({ label: c.detailLabel("limit"), value: Number(item.limit).toLocaleString(c.settings.locale) });
  if (Number(item.vipRank || 0))
    rows.push({
      label: c.detailLabel("tgwCard"),
      value: c.label("requiresRank", "Rank {rank}").replace("{rank}", String(item.vipRank)),
    });
  if (!rows.length) return nothing;
  return html`
    <section class="detail-section detail-section--facts">
      ${renderDetailSectionHeading(c.label("details", "Details"), "details")}
      <dl class="spec-list spec-list--split">
        ${rows.map(
          ({ label, value }) => html`
            <div>
              <dt>${label}</dt>
              <dd>${value}</dd>
            </div>
          `,
        )}
      </dl>
    </section>
  `;
}

async function loadShopFx(c: Controller) {
  c.fx = { status: "loading" };
  c.requestUpdate();
  const rates = await fetchShopFxRates();
  c.fx = rates ? { status: "ready", rates } : { status: "error" };
  c.requestUpdate();
}

/** Level-indexed pass rewards: one row per level, its tracks badged Free/Premium. */
function renderPassLevels(c: Controller, levels: Item[]) {
  if (!levels.length) return nothing;
  const grouped = new Map<number, Array<{ premium: boolean; rewards: Item[] }>>();
  for (const level of levels) {
    const key = Number(level.level || 0);
    const list = grouped.get(key) || [];
    list.push({
      premium: Boolean(level.premium),
      rewards: (Array.isArray(level.rewards) ? level.rewards : []) as Item[],
    });
    grouped.set(key, list);
  }
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("levelRewards", "Level rewards"), "rewards", { count: grouped.size })}
      <dl class="spec-list spec-list--split">
        ${[...grouped.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(
            ([level, tracks]) => html`
              <div>
                <dt>Lv.${level.toLocaleString(c.settings.locale)}</dt>
                <dd>
                  <div class="detail-object-list">
                    ${tracks.flatMap((track) =>
                      track.rewards.map((reward) =>
                        rewardRow(
                          c,
                          reward,
                          nothing,
                          c.label(track.premium ? "premium" : "free", track.premium ? "Premium" : "Free"),
                        ),
                      ),
                    )}
                  </div>
                </dd>
              </div>
            `,
          )}
      </dl>
    </section>
  `;
}

function renderPassMissions(c: Controller, tasks: Item[]) {
  if (!tasks.length) return nothing;
  return fold(
    c.label("passMissions", "Pass missions"),
    html`
      <ul class="detail-object-list" role="list">
        ${tasks.map(
          (task) => html`
            <li>
              ${rewardRow(
                c,
                { name: task.title } as Item,
                html`
                  <strong>
                    ${Number(task.points || 0).toLocaleString(c.settings.locale)} ${c.label("points", "pt")}
                  </strong>
                `,
              )}
            </li>
          `,
        )}
      </ul>
    `,
  );
}

function renderEventBands(c: Controller, bands: Item[]) {
  if (!bands.length) return nothing;
  return html`
    <section class="detail-section">
      ${renderDetailSectionHeading(c.label("bands", "Bands"), "details", { count: bands.length })}
      <ul class="detail-object-list" role="list">
        ${bands.map((band) => rewardRow(c, { name: band.name, image: band.logo || band.icon } as Item))}
      </ul>
    </section>
  `;
}

function eventRewardValue(row: Item): Item {
  const nested = row.reward && typeof row.reward === "object" ? (row.reward as Item) : row;
  return nested && typeof nested === "object" ? nested : {};
}

function renderEventHeading(
  title: string,
  kind: Parameters<typeof renderDetailSectionHeading>[1],
  options: { count?: number } = {},
) {
  return renderDetailSectionHeading(title, kind, { ...options, level: 2 });
}

/** Interpolate the authored message before rendering it, including repeated tokens. */
function eventText(c: Controller, key: string, fallback: string, values: Record<string, unknown> = {}): string {
  const format = (template: string) =>
    template.replace(/\{([\w.]+)(?::[^}]*)?\}/gu, (token, name: string) => {
      const value = values[name];
      return value === undefined
        ? token
        : typeof value === "number"
          ? value.toLocaleString(c.settings.locale)
          : String(value);
    });
  const result = format(c.label(key, fallback));
  return /\{[^{}]+\}/u.test(result) ? format(fallback) : result;
}

const eventRows = (value: unknown): Item[] =>
  Array.isArray(value) ? value.filter((row): row is Item => Boolean(row && typeof row === "object")) : [];
const eventRaw = (row: Item): Item => (row.raw && typeof row.raw === "object" ? (row.raw as Item) : {});
const eventNumber = (c: Controller, value: unknown) => Number(value ?? 0).toLocaleString(c.settings.locale);
const eventPoints = (c: Controller, value: unknown) =>
  eventText(c, "eventPoints", "{points} pt", { points: Number(value ?? 0) });

function eventRewardCondition(c: Controller, row: Item): string {
  const raw = eventRaw(row);
  if (row.sourceTable === "MasterEventAchievementLoopReward")
    return eventText(c, "eventLoopCondition", "Every {every} pt after {from} pt", {
      every: Number(raw._loopEventPoint ?? 0),
      from: Number(raw._loopStartEventPoint ?? 0),
    });
  const values: string[] = [];
  const point = raw._eventPoint ?? raw._point ?? raw._requiredPoint;
  if (point !== undefined) values.push(eventPoints(c, point));
  const rank = raw._rank ?? raw._ranking;
  if (rank !== undefined) values.push(eventText(c, "eventRankN", "Rank {rank}", { rank: Number(rank) }));
  if (raw._scoreRank !== undefined) values.push(EVENT_SCORE_RANK_NAMES[Number(raw._scoreRank)] || "—");
  for (const [field, key, fallback] of [
    ["_achievementCount", "eventGoalN", "Goal {count}"],
    ["_limitCount", "eventLimitN", "Limit {count}"],
    ["_boxNumber", "eventBoxN", "Box {count}"],
  ] as const)
    if (Number(raw[field]) > 0) values.push(eventText(c, key, fallback, { count: Number(raw[field]) }));
  return values.join(" · ");
}

/** One resource with its quantity and authored probability, also used in score tables. */
function eventRewardRow(c: Controller, row: Item, quantity = true, compact = false) {
  const reward = eventRewardValue(row);
  const name = c.localized(reward.name) || c.label("rewardUnavailable", "Reward unavailable");
  const secondary = c.localized(reward.secondary);
  const count = Number(reward.count ?? row.resourceCount ?? 1);
  const probability = eventRaw(row)._probability;
  const href = canonicalHref(c, String(reward.href || ""));
  const body = html`
    ${
      reward.image
        ? html`
            <img src=${String(reward.image)} alt="" width="32" height="32" loading="lazy" decoding="async" />
          `
        : icon("redeem", 24)
    }
    <span class=${compact ? "sr-only" : nothing} lang=${c.localizedLanguage(reward.name) || nothing}>
      ${name}${
        secondary
          ? html`
              <small class="detail-copy" lang=${c.localizedLanguage(reward.secondary) || nothing}>${secondary}</small>
            `
          : nothing
      }
    </span>
    ${
      quantity
        ? html`
            <strong>×${eventNumber(c, count)}</strong>
          `
        : nothing
    }
    ${
      probability !== undefined && Number(probability) < 10000
        ? html`
            <small>${eventText(c, "eventProbability", "{rate}% chance", { rate: Number(probability) / 100 })}</small>
          `
        : nothing
    }
  `;
  return html`
    <li>
      ${
        href
          ? html`
              <a
                class=${`detail-object event-reward${compact ? " event-reward--compact" : ""}`}
                href=${href}
                title=${compact ? name : nothing}
              >
                ${body}
              </a>
            `
          : html`
              <div
                class=${`detail-object event-reward${compact ? " event-reward--compact" : ""}`}
                title=${compact ? name : nothing}
              >
                ${body}
              </div>
            `
      }
    </li>
  `;
}

/** Shared tile media keeps a reserved ratio and the same Material progress control. */
function eventMedia(c: Controller, source: string, label = "", fallback = "") {
  return source
    ? html`
        <img
          data-src=${source}
          data-fallback=${fallback || nothing}
          alt=${label}
          decoding="async"
          @error=${nextImageCandidate}
        />
        <md-circular-progress
          class="event-media-progress"
          indeterminate
          aria-label=${c.label("loading", "Loading")}
        ></md-circular-progress>
      `
    : icon("image", 32);
}

function renderEventOverview(c: Controller, item: Item) {
  const instant = (value: unknown) =>
    Number((Array.isArray(value) ? value.find((part) => Number(part) > 0) : value) || 0);
  const start = instant(item.startAt),
    end = instant(item.endAt);
  const state = start > Date.now() ? "upcoming" : end && end < Date.now() ? "ended" : "ongoing";
  const eventItem = item.eventItem && typeof item.eventItem === "object" ? (item.eventItem as Item) : null;
  const activeRankings = [
    ["rankingDisabled", "eventScoreRanking", "Score ranking"],
    ["musicRankingDisabled", "eventSongRanking", "Song ranking"],
    ["totalMusicRankingDisabled", "eventTotalSongRanking", "Total song ranking"],
  ].filter(([field]) => item[field] === false);
  return html`
    <section class="detail-section event-overview">
      <div class="event-overview__facts">
        <span class="chip chip--static">
          <span class="chip__label">
            ${c.label(state, state === "ongoing" ? "Ongoing" : state === "upcoming" ? "Upcoming" : "Ended")}
          </span>
        </span>
        <dl class="spec-list spec-list--split">
          ${[
            ["startAt", start],
            ["endAt", end],
          ].map(([key, value]) =>
            value
              ? html`
                  <div>
                    <dt>${c.label(key === "startAt" ? "starts" : "ends", key === "startAt" ? "Starts" : "Ends")}</dt>
                    <dd><time datetime=${new Date(Number(value)).toISOString()}>${c.release(value)}</time></dd>
                  </div>
                `
              : nothing,
          )}
          <div class="spec-list__wide">
            <dt>${c.label("eventAvailableRankings", "Rankings")}</dt>
            <dd>
              ${activeRankings.length ? activeRankings.map(([, key, fallback]) => c.label(key, fallback)).join(" · ") : c.label("eventRankingOff", "No rankings")}
            </dd>
          </div>
        </dl>
        ${
          c.plainGameText(item.description)
            ? html`
                <p class="detail-copy" lang=${c.localizedLanguage(item.description) || nothing}>
                  ${c.plainGameText(item.description)}
                </p>
              `
            : nothing
        }
        ${
          eventItem
            ? html`
                <div class="event-overview__link">
                  <small>${c.label("eventItem", "Event item")}</small>
                  <ul class="detail-object-list">
                    ${eventRewardRow(c, eventItem, false)}
                  </ul>
                </div>
              `
            : nothing
        }
      </div>
    </section>
  `;
}

function renderEventSong(c: Controller, item: Item) {
  if (!item.song || typeof item.song !== "object") return nothing;
  const song = item.song as Item;
  return html`
    <section class="detail-section">
      ${renderEventHeading(c.label("eventSong", "Event song"), "songs")}
      <div class="collection collection--song">
        ${tile({ ...c.songTileOptions(song), href: canonicalHref(c, String(song.href || "")) || undefined })}
      </div>
    </section>
  `;
}

function renderEventCardGrid(c: Controller, cards: Item[]) {
  return html`
    <div class="event-card-groups">
      ${[
        [2, "member", "memberCards", "Member cards"],
        [3, "support", "supportCards", "Support cards"],
      ].map(([type, kind, key, fallback]) => {
        const entries = cards.filter(
          (card) => Number(card.resourceType) === type || card.kind === (type === 2 ? "MemberCard" : "SupportCard"),
        );
        if (!entries.length) return nothing;
        return html`
          <div class="stack stack--tight">
            <h3>${c.label(String(key), String(fallback))}</h3>
            <div class=${`collection collection--${kind}`}>
              ${entries.map((card) => {
                const options = c.cardTileOptions(card, kind);
                return tile({
                  ...options,
                  href: canonicalHref(c, String(card.href || "")) || undefined,
                  marks: [
                    ...(options.marks || []),
                    Number(card.rate) > 0
                      ? {
                          at: "bottom-start",
                          text: eventText(c, "eventUpRate", "UP {rate}%", { rate: Number(card.rate) * 100 }),
                        }
                      : null,
                  ],
                });
              })}
            </div>
          </div>
        `;
      })}
    </div>
  `;
}

function renderEventPickups(c: Controller, item: Item) {
  const cards = eventRows(item.pickupCards).map((row) => ({
    ...eventRewardValue(row.card as Item),
    resourceType: row.resourceType,
  }));
  if (!cards.length) return nothing;
  return html`
    <section class="detail-section">
      ${renderEventHeading(c.label("eventRewardCards", "Event reward cards"), "cards", { count: cards.length })}${renderEventCardGrid(c, cards)}
    </section>
  `;
}

function renderEventRecruitments(c: Controller, item: Item) {
  const recruitments = eventRows(item.recruitments);
  if (!recruitments.length) return nothing;
  return html`
    <section class="detail-section">
      ${renderEventHeading(c.label("eventRecruitments", "Related recruitments"), "content", { count: recruitments.length })}
      <p class="detail-copy">
        ${c.label("eventRecruitmentRelation", "Recruitments featuring this event’s bonus cards.")}
      </p>
      ${recruitments.map((gacha) => {
        const title = c.localized(gacha.title);
        const subtitle = [c.release(gacha.startAt), c.release(gacha.endAt)].filter(Boolean).join(" – ");
        return html`
          <div class="stack">
            <div class="collection collection--system event-recruitment-grid">
              ${tile({ kind: "system", title, titleLanguage: c.localizedLanguage(gacha.title), subtitle, label: title, image: String(gacha.image || ""), media: eventMedia(c, String(gacha.image || ""), title), aspectRatio: "16 / 9", href: canonicalHref(c, String(gacha.href || "")) || undefined, fit: "contain" })}
            </div>
            ${renderEventCardGrid(c, eventRows(gacha.featured))}
          </div>
        `;
      })}
    </section>
  `;
}

function renderEventStory(c: Controller, item: Item) {
  const story = item.story && typeof item.story === "object" ? (item.story as Item) : null;
  if (!story) return nothing;
  const episodes = eventRows(story.episodes);
  const groups = [
    ["eventMainEpisodes", "Main", episodes.filter((row) => !row.isExtraEpisode && !row.isAnotherEpisode)],
    ["eventExtraStory", "Extra", episodes.filter((row) => row.isExtraEpisode && !row.isAnotherEpisode)],
    ["eventAnotherStory", "Another", episodes.filter((row) => row.isAnotherEpisode)],
  ] as const;
  return html`
    <section class="detail-section">
      ${renderEventHeading(c.label("eventStory", "Event story"), "stories", { count: episodes.length })}
      ${
        c.plainGameText(story.description)
          ? html`
              <p class="detail-copy" lang=${c.localizedLanguage(story.description) || nothing}>
                ${c.plainGameText(story.description)}
              </p>
            `
          : nothing
      }
      ${groups.map(([key, fallback, entries]) =>
        entries.length
          ? html`
              <div class="stack stack--tight">
                <h3>${c.label(key, fallback)}</h3>
                <div class="collection collection--story">
                  ${entries.map((episode) => {
                    const titleValue = episode.titleText || episode.title || episode.prefix;
                    const title = c.localized(titleValue) || c.label("storyEpisode", "Story episode");
                    const subtitleValue = [episode.description, episode.caption, story.chapterName].find((value) =>
                      c.localized(value),
                    );
                    const bandIcon = String((story.bandDetails as Item | undefined)?.icon || "");
                    const seconds = Math.round(Number(episode.playTime || 0));
                    return tile(
                      storyTile(
                        episode,
                        {
                          title,
                          titleLanguage: c.localizedLanguage(titleValue),
                          subtitle: localizedContent(subtitleValue, c.settings.locale),
                          bandIcon: bandIcon ? c.imageForLocale(bandIcon) : "",
                          image: episodeArtwork(episode, story),
                          imageFallback: String(story.banner || ""),
                          fit: "cover",
                          natural: true,
                          onImageError: nextImageCandidate,
                          href: c.relatedEntityHref("stories", String(episode.storyId || episode.storyKey), {
                            mode: "event",
                          }),
                          duration: seconds
                            ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
                            : "",
                        },
                        [
                          Number(episode.eventPoint) > 0
                            ? {
                                at: "bottom-start",
                                text: eventText(c, "eventStoryUnlock", "Unlock at {points} pt", {
                                  points: Number(episode.eventPoint),
                                }),
                              }
                            : null,
                        ],
                      ),
                    );
                  })}
                </div>
              </div>
            `
          : nothing,
      )}
    </section>
  `;
}

function renderEventRewards(c: Controller, item: Item) {
  const all = eventRows(item.rewards);
  // Score-linked rewards live beside their point rows. Keep any unmatched row here.
  const mapped = new Set(
    eventRows(item.rankings).flatMap((rank) =>
      eventRows(rank.rewards).map((row) => `${row.sourceTable}:${row.sourceId}:${row.rewardId ?? row.resourceId}`),
    ),
  );
  const rewards = all.filter(
    (row) => !mapped.has(`${row.sourceTable}:${row.sourceId}:${row.rewardId ?? row.resourceId}`),
  );
  if (!rewards.length) return nothing;
  const labels: Record<string, [string, string]> = {
    MasterEventAchievementReward: ["achievementRewards", "Achievement rewards"],
    MasterEventAchievementLoopReward: ["loopRewards", "Loop rewards"],
    MasterEventBoxGachaReward: ["boxGachaRewards", "Box rewards"],
    MasterEventRankingReward: ["rankingRewards", "Ranking rewards"],
    MasterLiveEventReward: ["liveEventRewards", "Live rewards"],
    MasterChallengeLiveEventReward: ["challengeRewards", "Challenge rewards"],
  };
  const tables = new Map<string, Item[]>();
  for (const row of rewards) {
    const key = String(row.sourceTable || "");
    tables.set(key, [...(tables.get(key) || []), row]);
  }
  return html`
    <section class="detail-section">
      ${renderEventHeading(c.label("eventRewards", "Event rewards"), "rewards")}
      ${[...tables].map(([table, rows]) => {
        const tiers = new Map<string, Item[]>();
        for (const row of rows) {
          const key = String(row.sourceId);
          tiers.set(key, [...(tiers.get(key) || []), row]);
        }
        const [key, fallback] = labels[table] || ["rewards", "Rewards"];
        const content = html`
          <ul class="event-reward-tiers">
            ${[...tiers.values()].map(
              (tier) => html`
                <li>
                  <strong class="event-reward-condition">${eventRewardCondition(c, tier[0])}</strong>
                  <ul class="detail-object-list event-reward-values">
                    ${tier.map((row) => eventRewardRow(c, row))}
                  </ul>
                </li>
              `,
            )}
          </ul>
        `;
        return tiers.size > 12
          ? fold(c.label(key, fallback), content, eventNumber(c, tiers.size))
          : html`
              <div class="stack stack--tight">
                <h3>${c.label(key, fallback)}</h3>
                ${content}
              </div>
            `;
      })}
    </section>
  `;
}

function renderEventRankings(c: Controller, item: Item) {
  const rows = eventRows(item.rankings);
  if (!rows.length) return nothing;
  return html`
    <section class="detail-section">
      ${renderEventHeading(c.label("eventLiveRewards", "Live rewards"), "rewards")}
      <div class="event-parallel">
        ${["live", "challenge"].map((kind) => {
          const entries = rows.filter((row) => row.kind === kind);
          if (!entries.length) return nothing;
          return html`
            <div class="stack stack--tight">
              <h3>
                ${c.label(kind === "live" ? "liveRanking" : "challengeRanking", kind === "live" ? "Live" : "Challenge live")}
              </h3>
              <div class="table-scroll event-table-scroll">
                <table class="data-table event-score-table">
                  <thead>
                    <tr>
                      <th scope="col">${c.label("scoreRanks", "Score rank")}</th>
                      <th scope="col">${c.label("eventPointLabel", "Event points")}</th>
                      <th scope="col">${c.label("rewards", "Rewards")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${entries.map(
                      (row) => html`
                        <tr>
                          <th scope="row">${EVENT_SCORE_RANK_NAMES[Number(row.scoreRank)] || "—"}</th>
                          <td class="is-numeric">${eventPoints(c, row.pointValue)}</td>
                          <td>
                            <ul class="detail-object-list">
                              ${eventRows(row.rewards).map((reward) => eventRewardRow(c, reward, true, true))}
                            </ul>
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          `;
        })}
      </div>
    </section>
  `;
}

function renderEventEffects(c: Controller, item: Item) {
  const effects = eventRows(item.effects);
  if (!effects.length) return nothing;
  const levels = [...new Set(effects.flatMap((effect) => eventRows(effect.perRank).map((value) => Number(value.rank))))]
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 5)
    .sort((left, right) => left - right);
  const rank = levels.includes(Number(c.eventBonusRank)) ? Number(c.eventBonusRank) : levels[0] || 1;
  const targetKey = (row: Item) => {
    const raw = eventRaw(row);
    return [
      row.resourceTypeConstraint ?? raw._resourceTypeConstraint,
      raw._memberCardId,
      raw._supportCardId,
      raw._characterId,
      raw._bandId,
      raw._cardType,
      raw._tagId,
    ].join(":");
  };
  const groups = new Map<string, Item[]>();
  for (const effect of effects) {
    const key = targetKey(effect);
    groups.set(key, [...(groups.get(key) || []), effect]);
  }
  const bonusType = (row: Item) => Number(row.bonusType ?? eventRaw(row)._eventBonusType);
  const percent = (row: Item | undefined) => {
    const value = eventRows(row?.perRank).find((value) => Number(value.rank) === rank);
    return value ? `+${eventNumber(c, value.percent)}%` : "—";
  };
  return html`
    <section class="detail-section">
      ${renderEventHeading(c.label("eventEffects", "Event bonuses"), "effects", { count: effects.length })}
      ${renderLevelSwitch(
        c.label("eventBonusRank", "Card rank"),
        levels,
        rank,
        (value) => {
          c.eventBonusRank = value;
          c.requestUpdate();
        },
        (value) => eventText(c, "eventRankN", "Rank {rank}", { rank: value }),
      )}
      <div class="event-parallel">
        ${[2, 3].map((type) => {
          const entries = [...groups.values()].filter(
            (group) => Number(group[0].resourceTypeConstraint ?? eventRaw(group[0])._resourceTypeConstraint) === type,
          );
          if (!entries.length) return nothing;
          return html`
            <div class="stack stack--tight">
              <h3>
                ${c.label(type === 2 ? "memberCards" : "supportCards", type === 2 ? "Member cards" : "Support cards")}
              </h3>
              <div class="table-scroll event-table-scroll">
                <table class="data-table event-bonus-table">
                  <thead>
                    <tr>
                      <th scope="col">${c.label("eventBonusTarget", "Applies to")}</th>
                      <th scope="col">${c.label("eventParameterBonus", "Parameters")}</th>
                      <th scope="col">${c.label("eventItemBonus", "Event items")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${entries.map((group) => {
                      const first = group[0];
                      const targets =
                        first.targets && typeof first.targets === "object"
                          ? (Object.values(first.targets) as Item[])
                          : [];
                      const cardType = Number(first.cardType ?? eventRaw(first)._cardType);
                      const fallback =
                        cardType > 0
                          ? {
                              name: [
                                c.label(
                                  ["", "red", "blue", "green", "yellow", "purple"][cardType] || "attribute",
                                  "Attribute",
                                ),
                              ],
                            }
                          : { name: [c.label("eventAnyCard", "All cards")] };
                      return html`
                        <tr>
                          <th scope="row">
                            <ul class="detail-object-list">
                              ${(targets.length ? targets : [fallback]).map((target) => eventRewardRow(c, cardType > 0 ? { ...target, image: c.attributeMark(cardType), name: target.name || fallback.name } : target, false))}
                            </ul>
                          </th>
                          <td class="is-numeric">${percent(group.find((row) => bonusType(row) === type - 2))}</td>
                          <td class="is-numeric">${percent(group.find((row) => bonusType(row) === 2))}</td>
                        </tr>
                      `;
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          `;
        })}
      </div>
      ${
        c.plainGameText(item.bonusNote)
          ? html`
              <p class="detail-copy" lang=${c.localizedLanguage(item.bonusNote) || nothing}>
                ${c.plainGameText(item.bonusNote)}
              </p>
            `
          : nothing
      }
    </section>
  `;
}

function renderEventMissions(c: Controller, item: Item) {
  const missions = eventRows(item.missions);
  if (!missions.length) return nothing;
  return html`
    <section class="detail-section">
      ${renderEventHeading(c.label("missions", "Missions"), "missions", { count: missions.length })}
      <ul class="event-reward-tiers">
        ${missions.map(
          (mission) => html`
            <li>
              <span>${c.plainGameText(mission.description) || c.label("eventMission", "Event mission")}</span>
              <ul class="detail-object-list">
                ${eventRows(mission.rewards).map((reward) => eventRewardRow(c, reward))}
              </ul>
            </li>
          `,
        )}
      </ul>
    </section>
  `;
}

/** The per-resource body, placed after the generic facts section. */
export function renderGameSystemDetail(c: Controller, item: Item) {
  const resource = String(c.settings.resource || "");
  const rewards = (Array.isArray(item.rewards) ? item.rewards : []) as Item[];
  const pickups = (Array.isArray(item.pickupCards) ? item.pickupCards : []) as Item[];
  const rankings = (Array.isArray(item.rankings) ? item.rankings : []) as Item[];
  const effects = (Array.isArray(item.effects) ? item.effects : []) as Item[];
  switch (resource) {
    case "events":
      return html`
        <div class="event-detail">
          ${renderEventOverview(c, item)} ${renderEventSong(c, item)} ${renderEventPickups(c, item)}
          ${renderEventRecruitments(c, item)} ${renderEventStory(c, item)} ${renderEventEffects(c, item)}
          ${renderEventRankings(c, item)} ${renderEventRewards(c, item)} ${renderEventMissions(c, item)}
          ${
            !item.story && !pickups.length && !rewards.length && !rankings.length && !effects.length
              ? html`
                  <p class="detail-copy">
                    ${c.label("eventDetailsUnavailable", "No linked event details are available in this release.")}
                  </p>
                `
              : nothing
          }
        </div>
      `;
    case "gacha":
      return html`
        ${featuredGrid(c, (Array.isArray(item.featured) ? item.featured : []) as Item[])} ${renderDrawOptions(c, item)}
        ${renderRates(c, item)} ${renderSimulator(c, item)}
        ${rewardSection(c, rewards, c.label("prizePool", "Prize pool"), {
          collapsible: true,
          trailing: (reward) =>
            rateText(reward.rate)
              ? html`
                  <strong>
                    ${rateText(reward.rate)}${
                      Number(reward.count || 0) > 1
                        ? ` · ×${Number(reward.count).toLocaleString(c.settings.locale)}`
                        : ""
                    }
                  </strong>
                `
              : nothing,
        })}
      `;
    case "login-campaigns":
      return renderLoginDays(c, rewards);
    case "shop":
      return html`
        ${renderShopFacts(c, item)}${rewardSection(c, rewards, c.label("contents", "Contents"))}
      `;
    case "exchange":
      return renderExchangeGoods(c, item);
    case "circle":
      return rewardSection(c, rewards, c.label("rankRewards", "Rank rewards"));
    case "challenge":
      return item.songHref
        ? html`
            <section class="detail-section">
              <a class="button button--tonal" href=${c.resourceHref(String(item.songHref))}>
                ${icon("library_music", 18)}${c.label("viewSong", "View song")}
              </a>
            </section>
          `
        : nothing;
    case "passes":
      return item.kind === "monthly-pass"
        ? renderLoginDays(c, rewards)
        : html`
            ${renderPassLevels(c, (Array.isArray(item.levels) ? item.levels : []) as Item[])}
            ${renderPassMissions(c, (Array.isArray(item.tasks) ? item.tasks : []) as Item[])}
          `;
    case "real-lives":
      return renderEventBands(c, (Array.isArray(item.bands) ? item.bands : []) as Item[]);
    default:
      return nothing;
  }
}

export function initializeGameSystemDetail(c: Controller, item: Item) {
  c.sim = null;
  c.fx = null;
  c.eventBonusRank = 1;
  // Cash shop entries boot the rate fetch that fills the per-currency
  // conversions; the rates land as one shared session fetch.
  const payment = (item.payment || {}) as Item;
  if (availableShopCurrencies(payment.prices).length) void loadShopFx(c);
}

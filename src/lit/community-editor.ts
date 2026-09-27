import { LitElement, html, nothing } from "lit";
import { Editor, Node, mergeAttributes, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import { clientText } from "../i18n/client";
import { communityMarkup, communityDocument, safeCommunityLink } from "../lib/community-markup";
import { communityStamps, stampSources } from "./community-sticker";
import { currentReleaseServer, localizedText, type JsonRecord } from "./shared/catalog";
import { icon } from "./ui/icon";

export class CommunityEditor extends LitElement {
  static properties = {
    value: {},
    locale: {},
    raw: { state: true },
    picker: { state: true },
    stamps: { state: true },
    error: { state: true },
    loading: { state: true },
    menu: { state: true },
    compact: { type: Boolean, reflect: true },
    maxLength: { type: Number },
  };
  declare value: string;
  declare locale: string;
  declare raw: boolean;
  declare picker: boolean;
  declare stamps: JsonRecord[];
  declare error: string;
  declare loading: boolean;
  declare compact: boolean;
  declare maxLength: number;
  declare menu: "format" | "insert" | null;
  private editor?: Editor;
  private current = "";
  private mounted = false;
  constructor() {
    super();
    this.value = "";
    this.locale = "en";
    this.raw = false;
    this.picker = false;
    this.stamps = [];
    this.error = "";
    this.loading = false;
    this.menu = null;
    this.compact = false;
    this.maxLength = 20000;
  }
  createRenderRoot() {
    return this;
  }
  override focus() {
    this.editor?.commands.focus();
  }
  private text(key: string) {
    return clientText(this.locale, `communityPage.${key}`, key);
  }
  protected firstUpdated() {
    this.mount();
  }
  protected updated(changed: Map<string, unknown>) {
    if (changed.has("value") && this.value !== this.current) {
      this.current = this.value;
      this.editor?.commands.setContent(communityMarkup(this.value, this.text("spoiler"), this.locale), {
        emitUpdate: false,
      });
    }
  }
  connectedCallback() {
    super.connectedCallback();
    if (this.mounted) void this.updateComplete.then(() => this.mount());
  }
  disconnectedCallback() {
    this.editor?.destroy();
    this.editor = undefined;
    super.disconnectedCallback();
  }
  private mount() {
    const element = this.querySelector<HTMLElement>(".community-rich-editor__document");
    if (!element || this.editor) return;
    this.mounted = true;
    const Sticker = Node.create({
      name: "communitySticker",
      group: "inline",
      inline: true,
      atom: true,
      addAttributes: () => ({ token: { default: "" }, label: { default: "" }, locale: { default: this.locale } }),
      parseHTML: () => [{ tag: "community-sticker" }],
      renderHTML: ({ HTMLAttributes }) => [
        "community-sticker",
        mergeAttributes(HTMLAttributes, { contenteditable: "false" }),
      ],
    });
    const Spoiler = Node.create({
      name: "communitySpoiler",
      group: "block",
      content: "block+",
      defining: true,
      parseHTML: () => [{ tag: "details[data-spoiler]", contentElement: "div" }],
      renderHTML: () => [
        "details",
        { "data-spoiler": "", open: "" },
        ["summary", { contenteditable: "false" }, this.text("spoiler")],
        ["div", {}, 0],
      ],
    });
    this.current = this.value;
    this.editor = new Editor({
      element,
      extensions: [
        StarterKit.configure({
          heading: { levels: [2, 3, 4] },
          code: false,
          link: { openOnClick: false, autolink: false, defaultProtocol: "https", protocols: ["http", "https"] },
        }),
        Sticker,
        Spoiler,
        TextAlign.configure({ types: ["heading", "paragraph"] }),
        Highlight,
      ],
      content: communityMarkup(this.value, this.text("spoiler"), this.locale),
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": this.text("postBody"),
          class: "community-bbcode",
        },
      },
      onUpdate: ({ editor }) => this.change(communityDocument(editor.getJSON()).trimEnd()),
      onSelectionUpdate: () => this.requestUpdate(),
      onTransaction: () => this.requestUpdate(),
    });
  }
  private change(value: string) {
    this.current = value;
    this.value = value;
    this.dispatchEvent(new CustomEvent("body-change", { detail: value, bubbles: true, composed: true }));
  }
  private format(command: string) {
    const editor = this.editor;
    if (!editor) return;
    const chain = editor.chain().focus();
    if (command === "bold") chain.toggleBold().run();
    if (command === "italic") chain.toggleItalic().run();
    if (command === "underline") chain.toggleUnderline().run();
    if (command === "strike") chain.toggleStrike().run();
    if (command === "quote") chain.toggleBlockquote().run();
    if (command === "code") chain.toggleCodeBlock().run();
    if (command === "list") chain.toggleBulletList().run();
    if (command === "orderedList") chain.toggleOrderedList().run();
    if (command === "highlight") chain.toggleHighlight().run();
    if (command === "divider") chain.setHorizontalRule().run();
    if (command === "clearFormat") chain.unsetAllMarks().clearNodes().run();
    if (command === "unlink") chain.unsetLink().run();
    if (["left", "center", "right", "justify"].includes(command)) chain.setTextAlign(command).run();
    if (command === "paragraph") chain.setParagraph().run();
    if (["h2", "h3", "h4"].includes(command))
      chain.toggleHeading({ level: Number(command.slice(1)) as 2 | 3 | 4 }).run();
    if (command === "spoiler")
      editor.isActive("communitySpoiler")
        ? chain.lift("communitySpoiler").run()
        : chain.wrapIn("communitySpoiler").run();
    if (command === "undo") chain.undo().run();
    if (command === "redo") chain.redo().run();
    if (command === "link") this.querySelector<HTMLDialogElement>(".community-link-dialog")?.showModal();
    this.menu = null;
  }
  private async openStamps() {
    this.picker = !this.picker;
    if (!this.picker || this.stamps.length) return;
    this.loading = true;
    this.error = "";
    try {
      const catalog = await communityStamps(currentReleaseServer());
      if (this.isConnected)
        this.stamps = Object.values(catalog)
          .filter((item): item is JsonRecord => !!item && typeof item === "object")
          .sort((a, b) => Number(a.stampId) - Number(b.stampId));
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }
  private insertStamp(stamp: JsonRecord) {
    const label = localizedText(stamp.name, this.locale);
    const token = `${currentReleaseServer()}:${stamp.stampId}:${this.locale}`;
    this.editor
      ?.chain()
      .focus()
      .insertContent({ type: "communitySticker", attrs: { token, label, locale: this.locale } } as JSONContent)
      .run();
    this.picker = false;
  }
  render() {
    const common = [
      { command: "bold", icon: "format_bold", mark: "bold" },
      { command: "italic", icon: "format_italic", mark: "italic" },
      { command: "underline", icon: "format_underlined", mark: "underline" },
      { command: "link", icon: "link", mark: "link" },
    ];
    const format = [
      { command: "paragraph", icon: "notes", label: "paragraph" },
      { command: "h2", icon: "format_h2", label: "headingLarge" },
      { command: "h3", icon: "format_h3", label: "headingMedium" },
      { command: "h4", icon: "format_h4", label: "headingSmall" },
      { command: "strike", icon: "strikethrough_s", label: "strike" },
      { command: "highlight", icon: "format_ink_highlighter", label: "highlight" },
      { command: "left", icon: "format_align_left", label: "alignLeft" },
      { command: "center", icon: "format_align_center", label: "alignCenter" },
      { command: "right", icon: "format_align_right", label: "alignRight" },
      { command: "justify", icon: "format_align_justify", label: "alignJustify" },
      { command: "clearFormat", icon: "format_clear", label: "clearFormat" },
      { command: "unlink", icon: "link_off", label: "unlink" },
    ];
    const inserts = [
      { command: "list", icon: "format_list_bulleted", label: "list" },
      { command: "orderedList", icon: "format_list_numbered", label: "orderedList" },
      { command: "quote", icon: "format_quote", label: "quote" },
      { command: "code", icon: "code", label: "code" },
      { command: "spoiler", icon: "visibility_off", label: "spoiler" },
      { command: "divider", icon: "horizontal_rule", label: "divider" },
    ];
    return html`
      <div class="community-rich-editor">
        <div class="community-editor-toolbar-row">
          <div class="community-format-toolbar" role="toolbar" aria-label=${this.text("formatting")}>
            ${(this.compact ? common.slice(0, 2) : common).map(
              ({ command, icon: glyph, mark }) => html`
                <button
                  class="icon-button"
                  type="button"
                  title=${this.text(command)}
                  aria-label=${this.text(command)}
                  aria-pressed=${this.editor?.isActive(mark) || false}
                  ?disabled=${this.raw}
                  @click=${() => this.format(command)}
                >
                  ${icon(glyph, 20)}
                </button>
              `,
            )}
            <button
              class="icon-button"
              type="button"
              aria-label=${this.text("stickers")}
              title=${this.text("stickers")}
              aria-expanded=${this.picker}
              ?disabled=${this.raw}
              @click=${() => {
                this.menu = null;
                void this.openStamps();
              }}
            >
              ${icon("emoji_emotions", 20)}
            </button>
            <button
              class="icon-button"
              type="button"
              aria-label=${this.text("insert")}
              title=${this.text("insert")}
              aria-expanded=${this.menu === "insert"}
              ?disabled=${this.raw}
              @click=${() => {
                this.picker = false;
                this.menu = this.menu === "insert" ? null : "insert";
              }}
            >
              ${icon("add", 20)}
            </button>
            <button
              class="icon-button"
              type="button"
              aria-label=${this.text("undo")}
              title=${this.text("undo")}
              ?disabled=${this.raw || !this.editor?.can().undo()}
              @click=${() => this.format("undo")}
            >
              ${icon("undo", 20)}
            </button>
            <button
              class="icon-button"
              type="button"
              aria-label=${this.text("redo")}
              title=${this.text("redo")}
              ?disabled=${this.raw || !this.editor?.can().redo()}
              @click=${() => this.format("redo")}
            >
              ${icon("redo", 20)}
            </button>
          </div>
          <button
            class="icon-button community-format-more"
            type="button"
            aria-label=${this.text("moreFormatting")}
            title=${this.text("moreFormatting")}
            aria-expanded=${this.menu === "format"}
            @click=${() => {
              this.picker = false;
              this.menu = this.menu === "format" ? null : "format";
            }}
          >
            ${icon("text_format", 20)}
          </button>
        </div>
        ${
          this.menu
            ? html`
                <section
                  class="community-format-panel"
                  aria-label=${this.text(this.menu === "format" ? "moreFormatting" : "insert")}
                >
                  ${(this.menu === "format" ? format : inserts).map(
                    ({ command, icon: glyph, label }) => html`
                      <button type="button" ?disabled=${this.raw} @click=${() => this.format(command)}>
                        ${icon(glyph, 20)}
                        <span>${this.text(label)}</span>
                      </button>
                    `,
                  )}
                  ${
                    this.menu === "format"
                      ? html`
                          <button
                            class="community-source-toggle"
                            type="button"
                            aria-pressed=${this.raw}
                            @click=${() => {
                              if (this.raw && this.value.length > this.maxLength) {
                                this.error = this.text("invalidBody");
                                return;
                              }
                              this.raw = !this.raw;
                              this.menu = null;
                              if (!this.raw)
                                this.editor?.commands.setContent(
                                  communityMarkup(this.value, this.text("spoiler"), this.locale),
                                  { emitUpdate: false },
                                );
                            }}
                          >
                            ${icon("code", 20)}
                            <span>${this.raw ? this.text("visualEditor") : "BBCode"}</span>
                          </button>
                        `
                      : nothing
                  }
                </section>
              `
            : nothing
        }
        ${
          this.picker
            ? html`
                <section class="community-stamp-picker" aria-label=${this.text("stickers")}>
                  ${
                    this.loading
                      ? html`
                          <md-circular-progress indeterminate aria-label=${this.text("loading")}></md-circular-progress>
                        `
                      : nothing
                  }
                  ${
                    this.error
                      ? html`
                          <p role="alert">${this.error}</p>
                          <button
                            class="button button--text"
                            type="button"
                            @click=${() => {
                              this.picker = false;
                              void this.openStamps();
                            }}
                          >
                            ${this.text("retry")}
                          </button>
                        `
                      : nothing
                  }
                  ${this.stamps.map(
                    (stamp) => html`
                      <button
                        type="button"
                        title=${localizedText(stamp.name, this.locale)}
                        aria-label=${localizedText(stamp.name, this.locale)}
                        @click=${() => this.insertStamp(stamp)}
                      >
                        <img
                          src=${stampSources(stamp, this.locale)[0] || ""}
                          width="72"
                          height="72"
                          alt=""
                          loading="lazy"
                        />
                      </button>
                    `,
                  )}
                </section>
              `
            : nothing
        }
        <div class="community-rich-editor__document" ?hidden=${this.raw}></div>
        ${
          this.raw
            ? html`
                <textarea
                  class="community-source-editor"
                  aria-label="BBCode"
                  .value=${this.value}
                  @input=${(event: Event) => this.change((event.target as HTMLTextAreaElement).value)}
                ></textarea>
              `
            : nothing
        }
        ${
          this.error && !this.picker
            ? html`
                <p class="community-editor-error" role="alert">${this.error}</p>
              `
            : nothing
        }
        <div class="community-editor-count" aria-live="off" data-over-limit=${this.value.length > this.maxLength}>
          ${new Intl.NumberFormat(this.locale).format(this.value.length)} /
          ${new Intl.NumberFormat(this.locale).format(this.maxLength)}
        </div>
        <dialog class="community-link-dialog" aria-label=${this.text("link")}>
          <form
            method="dialog"
            @submit=${(event: SubmitEvent) => {
              event.stopPropagation();
              const data = new FormData(event.currentTarget as HTMLFormElement);
              if ((event.submitter as HTMLButtonElement)?.value === "cancel") return;
              const href = safeCommunityLink(String(data.get("url") || ""));
              if (!href) {
                event.preventDefault();
                return;
              }
              this.editor?.chain().focus().extendMarkRange("link").setLink({ href }).run();
            }}
          >
            <label>
              ${this.text("link")}
              <input
                name="url"
                type="url"
                placeholder="https://"
                required
                .value=${String(this.editor?.getAttributes("link").href || "")}
              />
            </label>
            <div class="dialog-actions">
              <button class="button button--text" value="cancel" formnovalidate>${this.text("cancel")}</button>
              <button class="button">${this.text("save")}</button>
            </div>
          </form>
        </dialog>
      </div>
    `;
  }
}
if (!customElements.get("community-editor")) customElements.define("community-editor", CommunityEditor);

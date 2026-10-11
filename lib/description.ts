// Listing descriptions are written and edited as plain text: paragraphs
// separated by blank lines, "Heading:" lines and "- " bullets. The same text
// becomes simple, safe HTML for eBay (descriptionHtml) — used both for the
// buyer preview and for publishing, so the two always match.

// Remove internal review labels without dropping the visible flaws that follow.
// Applied to generated prose only, before the seller edits it. Paragraph
// breaks and bullets are kept.
export function cleanGeneratedDescription(description: string): string {
  const lines = description.replace(/\r\n?/g, "\n").split("\n");
  const cleaned: string[] = [];
  for (const raw of lines) {
    const line = raw
      .replace(
        /\bpreliminary\s+(?:used\s+)?cosmetic\s+(?:condition|grade|assessment)\s*(?:with\s+)?/gi,
        "",
      )
      .replace(
        /\bbuyer\s+to\s+verify\s+measurements\s*\.?/gi,
        "See photos for measurements.",
      )
      .replace(/\bseller\s+to\s+verify\s*\.?/gi, "")
      .replace(/^(\s*)[•*–]\s+/, "$1- ")
      .replace(/(^|[.!?])\s*[;:,]+\s*/g, "$1 ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s+([.;,])/g, "$1")
      .trim()
      .replace(
        /(^|[.!?]\s+)([a-z])/g,
        (_, start, letter) => start + letter.toUpperCase(),
      );
    // A line emptied by the cleanup is dropped; real blank lines stay.
    if (!line && raw.trim()) continue;
    cleaned.push(line);
  }
  return cleaned
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const BULLET = /^\s*[-•*–]\s+(.*)$/;
// A short line ending in a colon, e.g. "Product Details:" or "Condition:".
const HEADING = /^([A-Z][A-Za-z0-9 &/'(),-]{0,40}):$/;

const STYLE = {
  wrap: "font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:900px;",
  h: "font-size:17px;margin:18px 0 6px;",
  p: "margin:0 0 12px;",
  ul: "margin:0 0 12px;padding-left:22px;",
  li: "margin:0 0 4px;",
};

// Plain-text description → mobile-friendly HTML. Every character of the text
// is escaped; the only markup is the fixed tags and inline styles below, so no
// script, link, image or other active content can appear.
export function descriptionHtml(text: string): string {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length)
      out.push(`<p style="${STYLE.p}">${paragraph.join("<br>")}</p>`);
    paragraph = [];
  };
  const flushBullets = () => {
    if (bullets.length)
      out.push(
        `<ul style="${STYLE.ul}">${bullets
          .map((b) => `<li style="${STYLE.li}">${b}</li>`)
          .join("")}</ul>`,
      );
    bullets = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      flushBullets();
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet && bullet[1].trim()) {
      flushParagraph();
      bullets.push(escapeHtml(bullet[1].trim()));
      continue;
    }
    flushBullets();
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      out.push(`<h3 style="${STYLE.h}">${escapeHtml(heading[1])}</h3>`);
      continue;
    }
    paragraph.push(escapeHtml(line));
  }
  flushParagraph();
  flushBullets();
  return out.length ? `<div style="${STYLE.wrap}">${out.join("")}</div>` : "";
}

// eBay limits the inventory item's own product description (the listing
// itself uses the offer's full listingDescription, which is never cut). The
// HTML is used when it fits; otherwise the text, escaped like the HTML and cut
// at a word boundary — never inside an escaped character such as "&amp;".
export const INVENTORY_DESCRIPTION_LIMIT = 4000;
export function inventoryDescription(text: string): string {
  const html = descriptionHtml(text);
  if (html.length <= INVENTORY_DESCRIPTION_LIMIT) return html;
  const plain = escapeHtml(text.trim());
  if (plain.length <= INVENTORY_DESCRIPTION_LIMIT) return plain;
  let cut = plain.slice(0, INVENTORY_DESCRIPTION_LIMIT - 1);
  const space = cut.search(/\s\S*$/);
  if (space > 0) cut = cut.slice(0, space);
  else {
    // No space to cut at: drop a trailing, incomplete escaped character.
    const amp = cut.lastIndexOf("&");
    if (amp >= 0 && !cut.slice(amp).includes(";")) cut = cut.slice(0, amp);
  }
  return `${cut.trimEnd()}…`;
}

// How every generated description is written (analysis and "Improve
// description").
export const DESCRIPTION_RULES = `DESCRIPTION: write the description as plain text (no HTML or markdown other than "- " bullets) in this layout, with a blank line between sections:
1. An opening paragraph of two or three natural sentences that identifies the product — verified brand, product type, style or collection — and its main selling points, using the words buyers search for and, where accurate, one common alternative name for the item type (for example button-down / button-up shirt).
2. A line "Product Details:" followed by one "- " bullet per verified fact (see the category guidance).
3. A line "Condition:" followed by an accurate statement of the visible condition and every visible flaw, saying where it is and how large when visible. Never call an item new, unworn or unused from photos.
4. A line "Measurements:" only when the seller supplied measurements (state them exactly as given) or when photos show the item with a measuring tape or ruler (then write exactly "See photos for measurements."). Otherwise leave this section out.
Add another short section (for example "Included:" or "Features:") only when the category needs it. Never include an empty section, placeholder, generic filler, sales hype, shipping, payment or returns text, or a keyword list. Use each search phrase at most once and only where it reads naturally; never name brands the item is not. State only facts readable on labels or tags, plainly visible in the photos, or given by the seller; leave out anything uncertain. Never invent measurements, materials, fiber percentages, model or style names, years, origins or features.`;

export const DESCRIPTION_GUIDANCE: Record<string, string> = {
  clothing: `Category guidance for the description. Clothing Product Details, each only when verified: brand; product type; style, line or collection; tagged size (and size type); fit; color and pattern; material with fiber percentages from the tag; sleeve length; neckline or collar; closure; pockets; lining; logos, embroidery or graphics; country of manufacture; care instructions; distinctive design details. Shoes: size (US/UK/EU as printed), width, upper, lining and sole material, closure, toe and heel, style name from the label, and the condition of soles, insoles and heels. Bags and accessories: style, exterior and interior material, closure, straps or handles, hardware color, pockets and compartments, and dimensions only when given.`,
  hard_goods: `Category guidance for the description. Product Details, each only when verified: brand or maker; model or part number from a label; type; printed specifications (capacity, power, voltage, size); color and material; included accessories, manuals or packaging; and testing status — say untested unless the seller provided test results. Do not use clothing fields.`,
  art: `Category guidance for the description. Product Details, each only when verified: artist or maker exactly as signed or labelled (otherwise unknown), title or subject, medium, technique, original or print as labelled, signature, frame, and dimensions only when given. Do not use clothing fields.`,
  media: `Category guidance for the description. Product Details, each only when verified: title, author, artist or platform, publisher or label, format, edition or printing, release year from the item, identifiers such as ISBN or catalog number, and the condition of the media, case, cover or sleeve. Do not use clothing fields.`,
  collectibles: `Category guidance for the description. Product Details, each only when verified: maker or brand, character, franchise or series, subject or theme, material, marks or stamps, year or date only when printed, set or card number, packaging, and any grading shown. Do not use clothing fields.`,
};

export function descriptionGuidance(profile: string | undefined): string {
  return (
    DESCRIPTION_GUIDANCE[profile ?? ""] ??
    "Category guidance for the description. Product Details: list only verified facts that matter for this kind of item; do not use clothing fields for non-clothing items."
  );
}

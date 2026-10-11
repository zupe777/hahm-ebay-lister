"use client";

import { DraftControls } from "./DraftControls";
import { DescriptionPreview } from "./DescriptionPreview";
import { draftIssues } from "@/lib/client-review";
import { useEffect, useMemo, useState } from "react";
import { SIZE_REQUIRED_CATEGORIES } from "@/lib/categories";
import type { ItemGroup, ListingResult, Photo } from "@/lib/types";
import { MAX_ANALYSIS_PHOTOS } from "@/lib/validation";
import { WRITE_STATE_LABEL } from "@/lib/write-status";
import { skuLocked, stickerMessage } from "@/lib/inventory-sticker";

const TITLE_LIMIT = 80;

// eBay's pre-owned condition tiers, matching the values the model returns.
const CONDITIONS: { value: string; label: string }[] = [
  { value: "NEW_WITH_TAGS", label: "New with tags" },
  { value: "NEW_NO_TAGS", label: "New without tags" },
  { value: "EXCELLENT", label: "Pre-owned · Excellent" },
  { value: "VERY_GOOD", label: "Pre-owned · Very good" },
  { value: "GOOD", label: "Pre-owned · Good" },
  { value: "FAIR", label: "Pre-owned · Fair" },
  { value: "FOR_PARTS_OR_NOT_WORKING", label: "For parts / not working" },
];

function formatPrice(value: ListingResult["suggested_price"]): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (n === undefined || Number.isNaN(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

function priceToInput(value: ListingResult["suggested_price"]): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  return n === undefined || Number.isNaN(n) ? "" : String(n);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="btn-ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {copied ? "✓ Copied" : `📋 Copy ${label}`}
    </button>
  );
}

interface ListingCardProps {
  group: ItemGroup;
  photoById: (id: string) => Photo | undefined;
  ebayConnected: boolean;
  onGroupEdit: (id: string, patch: Partial<ItemGroup>) => void;
  onEdit: (groupId: string, patch: Partial<ListingResult>) => void;
  onRenameSku: (groupId: string, sku: string) => void;
  onConfirmSku: (groupId: string) => void;
  onImproveDescription: (groupId: string) => Promise<string>;
  onAcceptDescription: (groupId: string, description: string) => void;
  onReadSticker: (groupId: string) => void;
  stickerReading?: boolean;
  stickerError?: string;
  // Another item in the batch has this SKU (letter case ignored).
  duplicate?: boolean;
  onRetry: (groupId: string) => void;
  onPost: (groupId: string) => void;
  // Set (true/false) only for not-written/failed items: chosen for
  // "Retry selected listings".
  retrySelected?: boolean;
  retryDisabled?: boolean;
  onToggleRetry?: () => void;
}

export function ListingCard({
  group,
  photoById,
  ebayConnected,
  onEdit,
  onGroupEdit,
  onRenameSku,
  onConfirmSku,
  onImproveDescription,
  onAcceptDescription,
  onReadSticker,
  stickerReading,
  stickerError,
  duplicate,
  onRetry,
  onPost,
  retrySelected,
  retryDisabled,
  onToggleRetry,
}: ListingCardProps) {
  const [open, setOpen] = useState(true);
  const listing = group.listing;
  const cover = photoById(group.photoIds[0]);

  const specifics = useMemo(() => {
    const entries = Object.entries(listing?.item_specifics ?? {});
    return entries.filter(
      ([k, v]) => v && String(v).trim() !== "" && !k.startsWith("---"),
    );
  }, [listing?.item_specifics]);

  const titleLen = listing?.title?.length ?? 0;

  // eBay's size standardization blocks apparel/footwear listings that are
  // missing a Size, so flag those for the seller before they post.
  const sizeRequired = SIZE_REQUIRED_CATEGORIES.has(listing?.category ?? "");
  const sizeMissing = sizeRequired && !(listing?.size ?? "").trim();

  // Publishing refuses a missing/zero price (no more invented defaults), so
  // flag it here the same way size is flagged — before the seller hits Post.
  const priceNum =
    typeof listing?.suggested_price === "string"
      ? parseFloat(listing.suggested_price)
      : listing?.suggested_price;
  const priceMissing =
    group.status === "done" &&
    (priceNum === undefined || Number.isNaN(priceNum) || priceNum <= 0);

  return (
    <article className={`listing-card status-${group.status}`}>
      <header className="listing-card-head" onClick={() => setOpen((o) => !o)}>
        {retrySelected !== undefined && (
          <input
            type="checkbox"
            aria-label={`Select ${group.sku || group.name} to write again`}
            checked={retrySelected}
            disabled={retryDisabled}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleRetry?.()}
          />
        )}
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="listing-cover" src={cover.previewUrl} alt="" />
        )}
        <div className="listing-card-title">
          <strong>
            {group.sku && <span className="sku-tag">{group.sku}</span>}
            {listing?.title || group.name}
          </strong>
          <span className="listing-card-sub">
            {group.status === "writing" && (
              <>
                <span className="spinner small" aria-hidden="true" />{" "}
                {WRITE_STATE_LABEL.writing}
              </>
            )}
            {group.status === "done" &&
              (priceMissing ? (
                <span style={{ color: "var(--color-danger)" }}>
                  ⚠️ needs a price
                </span>
              ) : (
                <>
                  {WRITE_STATE_LABEL.written} ·{" "}
                  {formatPrice(listing?.suggested_price)} ·{" "}
                  {draftIssues(group).length ? "needs review" : "ready"}
                </>
              ))}
            {group.status === "error" && (
              <span style={{ color: "var(--color-danger)" }}>
                ⚠️ {WRITE_STATE_LABEL.failed}:{" "}
                {group.error || "no reason was reported"}
              </span>
            )}
            {group.status === "idle" && WRITE_STATE_LABEL["not-written"]}
          </span>
        </div>
        {group.status === "error" ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={(e) => {
              e.stopPropagation();
              onRetry(group.id);
            }}
          >
            ↻ Retry
          </button>
        ) : (
          <span className="chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
        )}
      </header>

      {open &&
        (group.status === "idle" || group.status === "error") &&
        group.photoIds.length > MAX_ANALYSIS_PHOTOS && (
          <AnalysisPhotoPicker
            group={group}
            photoById={photoById}
            onGroupEdit={onGroupEdit}
          />
        )}

      {open && listing && group.status === "done" && (
        <fieldset
          className="listing-card-body"
          disabled={
            group.postStatus === "posted" || group.postStatus === "posting"
          }
        >
          <div className="result-field">
            <label>
              Title
              <span className={`count${titleLen > TITLE_LIMIT ? " over" : ""}`}>
                {titleLen}/{TITLE_LIMIT}
              </span>
            </label>
            <input
              type="text"
              className="title-input"
              value={listing.title}
              onChange={(e) => onEdit(group.id, { title: e.target.value })}
            />
            <div className="copy-row">
              <CopyButton text={listing.title} label="title" />
            </div>
          </div>

          <div className="meta-row">
            {/* SKU stays editable up until the item is posted, so a SKU fix
                never requires going back and re-writing listings (issue #30). */}
            <SkuField
              group={group}
              onRenameSku={onRenameSku}
              onConfirmSku={onConfirmSku}
              onReadSticker={onReadSticker}
              reading={Boolean(stickerReading)}
              error={stickerError}
              duplicate={Boolean(duplicate)}
            />
            <div
              className={`stat editable${priceMissing ? " needs-attention" : ""}`}
            >
              <label className="k" htmlFor={`price-${group.id}`}>
                Price
              </label>
              <div className="price-input">
                <span aria-hidden="true">$</span>
                <input
                  id={`price-${group.id}`}
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={priceToInput(listing.suggested_price)}
                  onChange={(e) =>
                    onEdit(group.id, {
                      suggested_price:
                        e.target.value === "" ? "" : Number(e.target.value),
                    })
                  }
                />
              </div>
              {group.comps?.ok && group.comps.median !== undefined && (
                <span className="comps-line" title={group.comps.basis}>
                  Market: {group.comps.count} similar active listings, $
                  {group.comps.low?.toFixed(0)}–${group.comps.high?.toFixed(0)}
                  {" · "}
                  <button
                    type="button"
                    className="comps-use"
                    onClick={() =>
                      onEdit(group.id, {
                        suggested_price:
                          group.comps!.listPrice ?? group.comps!.median,
                      })
                    }
                  >
                    {/* listPrice = median + the deployment's storewide markup */}
                    {group.comps.listPrice !== undefined
                      ? `use $${group.comps.listPrice.toFixed(2)} (median + markup)`
                      : `use median $${group.comps.median.toFixed(2)}`}
                  </button>
                </span>
              )}
            </div>
            <div className="stat editable">
              <label className="k" htmlFor={`cond-${group.id}`}>
                Condition
              </label>
              <select
                id={`cond-${group.id}`}
                value={listing.condition ?? "GOOD"}
                onChange={(e) =>
                  onEdit(group.id, {
                    condition: e.target.value,
                    ebay_condition: "",
                  })
                }
              >
                {/* Keep an unexpected model value selectable rather than losing it. */}
                {listing.condition &&
                  !CONDITIONS.some((c) => c.value === listing.condition) && (
                    <option value={listing.condition}>
                      {listing.condition.replace(/_/g, " ")}
                    </option>
                  )}
                {CONDITIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            {listing.brand && (
              <div className="stat">
                <div className="k">Brand</div>
                <div className="v">{listing.brand}</div>
              </div>
            )}
            {(sizeRequired || listing.size) && (
              <div
                className={`stat editable${sizeMissing ? " needs-attention" : ""}`}
              >
                <label className="k" htmlFor={`size-${group.id}`}>
                  Size
                </label>
                <input
                  id={`size-${group.id}`}
                  type="text"
                  className="size-input"
                  value={listing.size ?? ""}
                  placeholder={sizeRequired ? "e.g. M, 32x34, 10.5" : "—"}
                  onChange={(e) => onEdit(group.id, { size: e.target.value })}
                />
              </div>
            )}
          </div>

          {sizeMissing && (
            <p className="size-warning" role="alert">
              ⚠️ No size found on the tag. eBay now blocks apparel listings
              without a standard size — check the photos or measure the item,
              then fill in Size above before posting.
            </p>
          )}

          {priceMissing && (
            <p className="size-warning" role="alert">
              ⚠️ No price yet — the analysis couldn&rsquo;t estimate one for
              this item. Set a price above before posting
              {group.comps?.ok ? " (see the market check under Price)" : ""}.
            </p>
          )}

          <DescriptionField
            group={group}
            description={listing.description}
            onEdit={(description) => onEdit(group.id, { description })}
            onImprove={() => onImproveDescription(group.id)}
            onAccept={(description) =>
              onAcceptDescription(group.id, description)
            }
          />

          <button type="button" onClick={() => onRetry(group.id)}>
            Re-analyze selected photos (replaces this draft)
          </button>
          <DraftControls
            group={group}
            photoById={photoById}
            onGroupEdit={onGroupEdit}
          />
          {/* eBay posting */}
          {group.postStatus === "posted" ? (
            <>
              <p className="post-result ok">
                ✅ Posted to eBay
                {group.listingId ? (
                  <>
                    {" "}
                    ·{" "}
                    <a
                      href={`https://www.ebay.com/itm/${group.listingId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View listing ↗
                    </a>
                  </>
                ) : null}
              </p>
              {(group.postWarnings ?? []).map((w) => (
                <p className="post-result warn" key={w}>
                  ⚠️ {w}
                </p>
              ))}
            </>
          ) : ebayConnected ? (
            <div className="post-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onPost(group.id)}
                disabled={
                  group.postStatus === "posting" ||
                  draftIssues(group).length > 0
                }
              >
                {group.postStatus === "posting" ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Posting to
                    eBay…
                  </>
                ) : (
                  "🚀 Post this to eBay"
                )}
              </button>
              {group.postStatus === "error" && group.postError && (
                <p className="post-result err">⚠️ {group.postError}</p>
              )}
            </div>
          ) : (
            <p className="post-hint">
              Connect eBay (top of page) to post this listing.
            </p>
          )}
        </fieldset>
      )}
    </article>
  );
}

// For an item not written yet that has more photos than the AI can read in
// one request: choose which photos the AI analyzes (all still publish).
function AnalysisPhotoPicker({
  group: g,
  photoById,
  onGroupEdit,
}: {
  group: ItemGroup;
  photoById: (id: string) => Photo | undefined;
  onGroupEdit: (id: string, patch: Partial<ItemGroup>) => void;
}) {
  const chosen = g.analysisPhotoIds ?? g.photoIds;
  const over = chosen.length - MAX_ANALYSIS_PHOTOS;
  return (
    <fieldset className="listing-card-body">
      <legend>
        Photos for AI analysis ({chosen.length} of {g.photoIds.length} selected)
      </legend>
      <p className={over > 0 ? "note note-error" : "note"}>
        {over > 0
          ? `The AI can analyze at most ${MAX_ANALYSIS_PHOTOS} photos per item. Untick ${over} or more (keep labels, tags and flaws), then retry.`
          : `Ready: ${chosen.length} photos will be analyzed.`}
      </p>
      <div className="board-thumbs">
        {g.photoIds.map((id, i) => {
          const p = photoById(id);
          return (
            <label key={id}>
              <input
                type="checkbox"
                checked={chosen.includes(id)}
                onChange={(e) =>
                  onGroupEdit(g.id, {
                    analysisPhotoIds: e.target.checked
                      ? g.photoIds.filter((x) => x === id || chosen.includes(x))
                      : chosen.filter((x) => x !== id),
                  })
                }
              />
              {p?.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.previewUrl} width={64} alt={`Photo ${i + 1}`} />
              ) : (
                `Photo ${i + 1}`
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// The SKU (eBay Custom Label): the seller's inventory number. Shows where a
// value came from, the sticker reading and its photos, and the Confirm SKU
// and Read sticker actions. Only SKU fields change here.
function SkuField({
  group,
  onRenameSku,
  onConfirmSku,
  onReadSticker,
  reading,
  error,
  duplicate,
}: {
  group: ItemGroup;
  onRenameSku: (groupId: string, sku: string) => void;
  onConfirmSku: (groupId: string) => void;
  onReadSticker: (groupId: string) => void;
  reading: boolean;
  error?: string;
  duplicate: boolean;
}) {
  const locked = skuLocked(group);
  const s = group.sticker;
  const photoNumbers = (s?.photoIds ?? [])
    .map((id) => group.photoIds.indexOf(id) + 1)
    .filter((n) => n > 0);
  const photos = photoNumbers.length ? `photo ${photoNumbers.join(", ")}` : "";
  const fromSticker =
    group.skuSource === "sticker" && group.sku && s?.value === group.sku;
  const candidates =
    !locked && !group.skuConfirmed && s?.status === "ambiguous"
      ? (s.candidates ?? [])
      : [];
  return (
    <div className="stat editable sku-field">
      <label className="k" htmlFor={`sku-${group.id}`}>
        SKU
      </label>
      <input
        id={`sku-${group.id}`}
        type="text"
        className="size-input"
        value={group.sku}
        placeholder="Inventory sticker #"
        disabled={locked}
        onChange={(e) => onRenameSku(group.id, e.target.value)}
      />
      {group.sku.trim() &&
        (group.skuConfirmed ? (
          <span className="estimate-tag">
            {group.skuAutoConfirmed && group.skuSource === "sticker"
              ? "✓ SKU auto-confirmed"
              : "✓ SKU confirmed"}
            {group.skuSource === "sticker" && photos
              ? ` · from sticker, ${photos}`
              : ""}
          </span>
        ) : group.postStatus === "posted" ? null : (
          <span className="size-warning" role="note">
            {fromSticker
              ? `Suggested from the inventory sticker${photos ? ` (${photos})` : ""}. Check it against the sticker, then confirm.`
              : group.publicationAttemptSku
                ? "This SKU was already used in a publishing attempt, so it cannot change. Check it, then confirm."
                : group.skuSource
                  ? "Confirm this SKU before publishing."
                  : "SKU from an earlier version of Zupe. Check it, then confirm."}
          </span>
        ))}
      {/* Confirming never changes the SKU, so a SKU locked by an earlier
          publishing attempt can still be confirmed for the retry. */}
      {group.postStatus !== "posted" &&
        group.postStatus !== "posting" &&
        group.sku.trim() &&
        !group.skuConfirmed && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => onConfirmSku(group.id)}
          >
            Confirm SKU
          </button>
        )}
      {!group.sku.trim() && s && s.status !== "read" && (
        <span className="size-warning" role="note">
          {stickerMessage(s)}
          {photos ? ` (${photos})` : ""} Enter the SKU from the sticker.
        </span>
      )}
      {candidates.length > 0 && (
        <span className="copy-row" role="group" aria-label="Sticker readings">
          {candidates.map((c) => (
            <button
              type="button"
              className="btn-ghost"
              key={c}
              onClick={() => onRenameSku(group.id, c)}
            >
              Use {c}
            </button>
          ))}
        </span>
      )}
      {!group.sku.trim() && group.legacySku && (
        <span className="size-warning" role="note">
          The SKU {group.legacySku} was generated automatically by an earlier
          version and has been removed. Enter your inventory number.
        </span>
      )}
      {duplicate && (
        <span className="size-warning" role="note">
          Another item in this batch has this SKU.
        </span>
      )}
      {!locked && (
        <button
          type="button"
          className="btn-ghost"
          disabled={reading}
          onClick={() => onReadSticker(group.id)}
        >
          {reading ? "Reading sticker…" : "🔎 Read sticker"}
        </button>
      )}
      {error && (
        <span className="size-warning" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

// The editable plain-text description, its buyer preview, and the optional
// "Improve description" proposal. A proposal changes nothing until the seller
// clicks "Use This Description"; Cancel discards it.
function DescriptionField({
  group,
  description,
  onEdit,
  onImprove,
  onAccept,
}: {
  group: ItemGroup;
  description: string;
  onEdit: (description: string) => void;
  onImprove: () => Promise<string>;
  onAccept: (description: string) => void;
}) {
  const [preview, setPreview] = useState(false);
  const [improving, setImproving] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);
  const [error, setError] = useState("");
  const locked =
    group.postStatus === "posted" || group.postStatus === "posting";
  const improve = async () => {
    setImproving(true);
    setError("");
    try {
      setProposal(await onImprove());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImproving(false);
    }
  };
  return (
    <div className="result-field">
      <label htmlFor={`description-${group.id}`}>Description</label>
      <textarea
        id={`description-${group.id}`}
        value={description}
        onChange={(e) => onEdit(e.target.value)}
        rows={10}
      />
      <span className="field-hint">
        Plain text: separate paragraphs with a blank line, start bullet lines
        with &ldquo;- &rdquo;, and put section names such as
        &ldquo;Condition:&rdquo; on their own line.
      </span>
      <div className="copy-row">
        <CopyButton text={description} label="description" />
        <button
          type="button"
          className="btn-ghost"
          aria-expanded={preview}
          onClick={() => setPreview((p) => !p)}
        >
          {preview ? "Hide buyer preview" : "👁 Buyer preview"}
        </button>
        {!locked && (
          <button
            type="button"
            className="btn-ghost"
            disabled={improving || proposal !== null}
            onClick={() => void improve()}
          >
            {improving ? "Improving description…" : "✨ Improve description"}
          </button>
        )}
      </div>
      {preview && <DescriptionPreview text={description} />}
      {error && (
        <p className="size-warning" role="alert">
          {error}
        </p>
      )}
      {proposal !== null && !locked && (
        <div
          className="description-compare"
          role="group"
          aria-label="Proposed description"
        >
          {group.descriptionSource === "seller" && (
            <p className="size-warning" role="note">
              You edited this description. Using the proposal replaces your
              edits; Cancel keeps them.
            </p>
          )}
          <div className="description-compare-cols">
            <div>
              <strong>Current description</strong>
              <pre
                className="description-text"
                aria-label="Current description"
              >
                {description}
              </pre>
            </div>
            <div>
              <strong>Proposed description</strong>
              <pre
                className="description-text"
                aria-label="Proposed description text"
              >
                {proposal}
              </pre>
            </div>
          </div>
          <DescriptionPreview
            text={proposal}
            label="Buyer preview of the proposed description"
          />
          <div className="copy-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                onAccept(proposal);
                setProposal(null);
              }}
            >
              Use This Description
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setProposal(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

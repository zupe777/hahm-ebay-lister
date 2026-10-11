"use client";

import { useEffect, useState } from "react";
import type { AccountOptions } from "@/lib/ebay/publish";
import {
  DEFAULT_FIELDS,
  checkDefaults,
  type DefaultKey,
  type SellerDefaults,
} from "@/lib/shipping-defaults";

// "Default listing settings": the seller picks the shipping, payment and
// return policies and the shipping origin once, from the connected eBay
// account. Saved defaults fill blank fields of unpublished listings only.
export function DefaultSettings({
  options,
  optionsError,
  saved,
  notice,
  onSave,
}: {
  options?: AccountOptions;
  optionsError?: string;
  saved: SellerDefaults;
  notice?: string;
  onSave: (defaults: SellerDefaults) => void;
}) {
  const check = options ? checkDefaults(saved, options) : undefined;
  const initial = () =>
    Object.fromEntries(
      DEFAULT_FIELDS.map(({ key }) => [
        key,
        check && ["ok", "renamed"].includes(check.fields[key].status)
          ? saved[key]!.id
          : "",
      ]),
    ) as Record<DefaultKey, string>;
  const [choice, setChoice] = useState(initial);
  const savedJson = JSON.stringify(saved);
  // Follow the saved defaults and the freshly loaded account options.
  useEffect(() => setChoice(initial()), [savedJson, options]);
  const anySaved = Object.keys(saved).length > 0;
  const problems = check
    ? DEFAULT_FIELDS.filter(({ key }) =>
        ["missing", "renamed"].includes(check.fields[key].status),
      )
    : [];
  // Open while nothing is saved or something needs the seller's attention;
  // remounting on that change re-applies the open state.
  const attention =
    !anySaved || Boolean(check?.mismatch) || problems.length > 0;
  return (
    <section className="default-settings" aria-label="Default listing settings">
      {check?.mismatch && (
        <p className="note-error" role="alert">
          None of your saved defaults exist on the connected eBay account (is a
          different account connected?). Nothing was filled in. Choose new
          defaults below.
        </p>
      )}
      {check &&
        !check.mismatch &&
        problems.map(({ key, label }) => {
          const f = check.fields[key];
          return f.status === "missing" ? (
            <p className="size-warning" role="note" key={key}>
              {label}: saved default &ldquo;{f.saved!.name}&rdquo; no longer
              exists on this eBay account and is not used. Choose a replacement.
            </p>
          ) : (
            <p className="field-hint" key={key}>
              {label}: renamed on eBay to &ldquo;{f.currentName}&rdquo; (saved
              as &ldquo;{f.saved!.name}&rdquo;). It is still used.
            </p>
          );
        })}
      {notice && (
        <p className="note" aria-live="polite">
          {notice}
        </p>
      )}
      <details key={attention ? "open" : "closed"} open={attention}>
        <summary>
          Default listing settings
          {anySaved && check && !check.mismatch ? "" : " · not set"}
        </summary>
        <p className="field-hint">
          Choose these once. They fill in automatically on listings where the
          field is still blank; you can change any listing individually.
        </p>
        {!options && (
          <p className="note">
            {optionsError
              ? `eBay policies could not be loaded: ${optionsError}`
              : "Loading your eBay policies and locations…"}
          </p>
        )}
        {options && (
          <div className="default-settings-fields">
            {DEFAULT_FIELDS.map(({ key, kind, label }) => (
              <div className="default-field" key={key}>
                <span>{label}</span>
                <select
                  aria-label={`Default ${label.toLowerCase()}`}
                  value={choice[key]}
                  onChange={(e) =>
                    setChoice((c) => ({ ...c, [key]: e.target.value }))
                  }
                >
                  <option value="">No default</option>
                  {options[kind].map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}
        {options && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              const next: SellerDefaults = {};
              for (const { key, kind } of DEFAULT_FIELDS) {
                const o = options[kind].find((x) => x.id === choice[key]);
                if (o) next[key] = { id: o.id, name: o.name };
              }
              onSave(next);
            }}
          >
            Save defaults
          </button>
        )}
      </details>
    </section>
  );
}

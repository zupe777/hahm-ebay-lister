"use client";

import { descriptionHtml } from "@/lib/description";

// The description as buyers will see it on eBay: exactly the HTML that
// publishing sends (lib/description.ts escapes every character of the text).
export function DescriptionPreview({
  text,
  label = "Buyer preview",
}: {
  text: string;
  label?: string;
}) {
  return (
    <div
      className="description-preview"
      role="region"
      aria-label={label}
      dangerouslySetInnerHTML={{ __html: descriptionHtml(text) }}
    />
  );
}

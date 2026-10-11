#!/usr/bin/env bash
# One-shot deploy helper for Zupe HQ.
#
# First time only:   vercel login        (logs into your Vercel account)
# Then, any time:    ./deploy.sh         (deploys the current code to your live site)
#
# It also pushes your ANTHROPIC_API_KEY from .env.local up to Vercel so the
# live site can write listings. Your key is never committed to git.

set -euo pipefail
cd "$(dirname "$0")"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }

# 1. Make sure you're logged in.
if ! vercel whoami >/dev/null 2>&1; then
  echo
  bold "You're not logged into Vercel yet."
  echo "Run this once, follow the prompts, then re-run ./deploy.sh:"
  echo
  echo "    vercel login"
  echo
  exit 1
fi
bold "✓ Logged in to Vercel as $(vercel whoami 2>/dev/null)"

# 2. Link (or create) the Vercel project for this folder, using defaults.
bold "Linking project (accepting defaults)…"
vercel link --yes >/dev/null 2>&1 || true

# 3. Push the Anthropic key from .env.local into Vercel for every environment.
if [ -f .env.local ]; then
  KEY="$(grep -E '^ANTHROPIC_API_KEY=' .env.local | head -1 | cut -d= -f2-)"
  if [ -n "${KEY:-}" ]; then
    bold "Uploading ANTHROPIC_API_KEY to Vercel…"
    for ENVN in production preview development; do
      vercel env rm ANTHROPIC_API_KEY "$ENVN" -y >/dev/null 2>&1 || true
      printf "%s" "$KEY" | vercel env add ANTHROPIC_API_KEY "$ENVN" >/dev/null 2>&1 || true
    done
    echo "  done."
  else
    bold "⚠ No ANTHROPIC_API_KEY found in .env.local — add it in the Vercel dashboard later."
  fi
else
  bold "⚠ No .env.local found — set ANTHROPIC_API_KEY in the Vercel dashboard later."
fi

# 4. Deploy to production.
bold "Deploying to production… (first build takes ~1 minute)"
vercel --prod --yes

echo
bold "✅ Done! Your live URL is shown above. Bookmark it on your Mac and phone."
